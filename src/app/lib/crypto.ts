import { ref, get, set, update } from "firebase/database";
import { db } from "@/app/lib/firebase";

/* -----------------------------------------------------------
 * IndexedDB: lokaler, nicht-exportierbarer Schlüsselspeicher
 * ---------------------------------------------------------*/

const IDB_NAME = "dabubble-keys";
const IDB_STORE = "identityKeys";
const IDB_RATCHET_STORE = "ratchetState";

type StoredIdentity = {
  uid: string;
  ecdhPrivateKey: CryptoKey;
  ecdhPublicKey: CryptoKey;
  ecdsaPrivateKey: CryptoKey;
  ecdsaPublicKey: CryptoKey;
};

// Wird ausschließlich beim Neu-Erzeugen eines Schlüsselpaars vergeben (siehe
// ensureIdentityKeys) und zusammen mit dem Public Key veröffentlicht. Erlaubt
// anderen Clients zu erkennen, dass ein zuvor für diesen Nutzer gewrapptes
// Channel-Key-Envelope nicht mehr zum AKTUELLEN Schlüsselpaar passt (z. B.
// nach einem Origin-/Geräte-Wechsel ohne Schlüssel-Backup, siehe
// ensureIdentityKeys-Kommentar) und es neu wrappen müssen, statt den
// Nutzer dauerhaft mit einem unentschlüsselbaren Envelope hängen zu lassen.

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE, { keyPath: "uid" });
      }
      if (!req.result.objectStoreNames.contains(IDB_RATCHET_STORE)) {
        req.result.createObjectStore(IDB_RATCHET_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Generischer Key-Value-Speicher für Ratchet-Zustand (wartende Ephemer-
 * Privatschlüssel, hergeleitete Perioden-Wurzeln, Ketten-Zustand,
 * Skipped-Message-Keys) — bewusst als ein Store mit präfixierten Schlüsseln
 * statt vieler einzelner Object-Stores, um die IDB-Migration einfach zu
 * halten.
 */
async function ratchetGet<T>(key: string): Promise<T | undefined> {
  const dbi = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_RATCHET_STORE, "readonly");
    const req = tx.objectStore(IDB_RATCHET_STORE).get(key);
    req.onsuccess = () => resolve(req.result?.value as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function ratchetPut(key: string, value: unknown): Promise<void> {
  const dbi = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_RATCHET_STORE, "readwrite");
    tx.objectStore(IDB_RATCHET_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function ratchetDelete(key: string): Promise<void> {
  const dbi = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_RATCHET_STORE, "readwrite");
    tx.objectStore(IDB_RATCHET_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(uid: string): Promise<StoredIdentity | undefined> {
  const dbi = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(uid);
    req.onsuccess = () => resolve(req.result as StoredIdentity | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(identity: StoredIdentity): Promise<void> {
  const dbi = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(identity);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* -----------------------------------------------------------
 * Base64 <-> ArrayBuffer
 * ---------------------------------------------------------*/

function bufToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* -----------------------------------------------------------
 * Identität: Schlüsselpaare erzeugen / laden
 * ---------------------------------------------------------*/

export type PublicIdentity = {
  ecdhPublicJwk: JsonWebKey;
  ecdsaPublicJwk: JsonWebKey;
  keyVersion?: string;
};

async function generateIdentity(uid: string): Promise<StoredIdentity> {
  // extractable: true (statt vorher false) ist eine bewusste Abschwächung,
  // NUR um das optionale Schlüssel-Backup (siehe exportIdentityBackup unten)
  // überhaupt zu ermöglichen — ohne exportierbare Keys ließe sich der
  // private Schlüssel nie in ein Backup verpacken. Der zusätzliche Spielraum
  // dadurch ist gering: eine erfolgreiche XSS-Lücke könnte ohnehin schon
  // sämtliche gerade entschlüsselten Klartexte direkt aus dem DOM/State
  // auslesen, unabhängig davon, ob der Schlüssel selbst exportierbar ist.
  const ecdhPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const ecdsaPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  return {
    uid,
    ecdhPrivateKey: ecdhPair.privateKey,
    ecdhPublicKey: ecdhPair.publicKey,
    ecdsaPrivateKey: ecdsaPair.privateKey,
    ecdsaPublicKey: ecdsaPair.publicKey,
  };
}

/**
 * Stellt sicher, dass für `uid` ein lokales Schlüsselpaar existiert
 * (in IndexedDB, private Keys nicht exportierbar) und dass die
 * Public Keys unter `publicKeys/$uid` in Firebase hinterlegt sind.
 */
export async function ensureIdentityKeys(uid: string): Promise<void> {
  let identity = await idbGet(uid);
  const justGenerated = !identity;

  if (!identity) {
    identity = await generateIdentity(uid);
    await idbPut(identity);
  }

  // Nur beim erstmaligen Erzeugen auf DIESEM Gerät hochladen. Ein neues
  // Gerät ohne lokale Kopie der Schlüssel bekommt sonst nie einen zu seinem
  // eigenen privaten Schlüssel passenden Public Key veröffentlicht (und
  // signiert/entschlüsselt fortan mit einem Schlüssel, den niemand kennt).
  // Bewusste Einschränkung statt Multi-Device-Sync: das zuletzt genutzte
  // Gerät gewinnt, ältere Geräte müssen sich neu identifizieren (passt zur
  // Entscheidung "kein Schlüssel-Backup").
  if (justGenerated) {
    const ecdhPublicJwk = await crypto.subtle.exportKey("jwk", identity.ecdhPublicKey);
    const ecdsaPublicJwk = await crypto.subtle.exportKey("jwk", identity.ecdsaPublicKey);
    const keyVersion = crypto.randomUUID();
    await set(ref(db, `publicKeys/${uid}`), {
      ecdhPublicJwk,
      ecdsaPublicJwk,
      keyVersion,
    });
  }
}

async function getOwnIdentity(uid: string): Promise<StoredIdentity> {
  const identity = await idbGet(uid);
  if (!identity) {
    throw new Error(
      `Keine lokalen Schlüssel für ${uid} gefunden. ensureIdentityKeys() wurde nicht aufgerufen.`
    );
  }
  return identity;
}

/* -----------------------------------------------------------
 * Optionales, passphrase-verschlüsseltes Schlüssel-Backup — rein client-
 * seitig: Firebase bekommt nie die Passphrase noch den Klartext-Schlüssel zu
 * sehen, nur den PBKDF2-Salt und das AES-GCM-Chiffrat. Ohne dieses Backup
 * gilt weiterhin "letztes Gerät gewinnt, alte Nachrichten unwiederbringlich
 * weg" (siehe ensureIdentityKeys) — mit Backup kann dieselbe Identität
 * (und damit der Zugriff auf alte, bereits gewrappte Channel-Keys sowie
 * laufende DM-Ratchet-Perioden) auf einem neuen Gerät wiederhergestellt
 * werden, wenn der Nutzer sich VORHER dafür entschieden hat, eins anzulegen.
 * ---------------------------------------------------------*/

export type KeyBackup = {
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
  iterations: number;
  createdAt: number;
};

const BACKUP_PBKDF2_ITERATIONS = 250_000;

async function deriveBackupKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bytesToBuf(salt), iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Verschlüsselt die eigenen privaten Identitätsschlüssel mit einer vom
 * Nutzer gewählten Passphrase. Wirft, wenn die lokale Identität (noch) mit
 * extractable: false erzeugt wurde (Altbestand vor dieser Funktion) — in dem
 * Fall ist kein Export möglich, ohne die Identität komplett neu zu erzeugen
 * (was wiederum den bekannten "neues Gerät"-Reset auslösen würde). */
export async function exportIdentityBackup(
  uid: string,
  passphrase: string
): Promise<KeyBackup> {
  if (passphrase.length < 8) {
    throw new Error("Passphrase muss mindestens 8 Zeichen lang sein.");
  }
  const identity = await getOwnIdentity(uid);

  let ecdhPrivateJwk: JsonWebKey;
  let ecdsaPrivateJwk: JsonWebKey;
  try {
    [ecdhPrivateJwk, ecdsaPrivateJwk] = await Promise.all([
      crypto.subtle.exportKey("jwk", identity.ecdhPrivateKey),
      crypto.subtle.exportKey("jwk", identity.ecdsaPrivateKey),
    ]);
  } catch {
    throw new Error(
      "Diese Schlüssel wurden vor Einführung des Backups erzeugt und können nicht exportiert werden."
    );
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, BACKUP_PBKDF2_ITERATIONS);

  const plaintext = new TextEncoder().encode(
    JSON.stringify({ ecdhPrivateJwk, ecdsaPrivateJwk })
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  const backup: KeyBackup = {
    saltB64: bufToBase64(salt.buffer),
    ivB64: bufToBase64(iv.buffer),
    ciphertextB64: bufToBase64(ciphertext),
    iterations: BACKUP_PBKDF2_ITERATIONS,
    createdAt: Date.now(),
  };
  await set(ref(db, `encryptedKeyBackup/${uid}`), backup);
  return backup;
}

/** Stellt die Identität aus einem zuvor angelegten Backup wieder her und
 * ersetzt damit die evtl. auf diesem Gerät bereits vorhandene lokale
 * Identität. Bei falscher Passphrase schlägt die AES-GCM-Entschlüsselung
 * mit einem OperationError fehl (Authentifizierungs-Tag passt nicht) —
 * dasselbe Fehlerbild wie bei den anderen unwrap-Funktionen in dieser Datei. */
export async function restoreIdentityBackup(
  uid: string,
  passphrase: string
): Promise<void> {
  const snap = await get(ref(db, `encryptedKeyBackup/${uid}`));
  if (!snap.exists()) {
    throw new Error("Für dieses Konto wurde noch kein Schlüssel-Backup angelegt.");
  }
  const backup = snap.val() as KeyBackup;

  const salt = new Uint8Array(base64ToBuf(backup.saltB64));
  const key = await deriveBackupKey(passphrase, salt, backup.iterations);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBuf(backup.ivB64) },
      key,
      base64ToBuf(backup.ciphertextB64)
    );
  } catch {
    throw new Error("Falsche Passphrase.");
  }

  const { ecdhPrivateJwk, ecdsaPrivateJwk } = JSON.parse(
    new TextDecoder().decode(plaintext)
  ) as { ecdhPrivateJwk: JsonWebKey; ecdsaPrivateJwk: JsonWebKey };

  // EC-Private-JWKs enthalten die öffentlichen Koordinaten (x/y) bereits mit
  // — der Public Key lässt sich daraus ableiten, indem man dasselbe JWK ohne
  // "d" (den privaten Skalar) als Public Key importiert, statt ihn separat
  // mitspeichern zu müssen.
  const ecdhPublicJwk: JsonWebKey = { ...ecdhPrivateJwk, d: undefined, key_ops: [] };
  const ecdsaPublicJwk: JsonWebKey = { ...ecdsaPrivateJwk, d: undefined, key_ops: [] };

  const [ecdhPrivateKey, ecdhPublicKey, ecdsaPrivateKey, ecdsaPublicKey] =
    await Promise.all([
      crypto.subtle.importKey(
        "jwk",
        ecdhPrivateJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
      ),
      crypto.subtle.importKey(
        "jwk",
        ecdhPublicJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
      ),
      crypto.subtle.importKey(
        "jwk",
        ecdsaPrivateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign"]
      ),
      crypto.subtle.importKey(
        "jwk",
        ecdsaPublicJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"]
      ),
    ]);

  await idbPut({ uid, ecdhPrivateKey, ecdhPublicKey, ecdsaPrivateKey, ecdsaPublicKey });
}

export async function hasKeyBackup(uid: string): Promise<boolean> {
  const snap = await get(ref(db, `encryptedKeyBackup/${uid}`));
  return snap.exists();
}

/* -----------------------------------------------------------
 * Public Keys anderer Nutzer laden (mit Cache)
 * ---------------------------------------------------------*/

const publicKeyCache = new Map<
  string,
  Promise<{ ecdh: CryptoKey; ecdsa: CryptoKey; keyVersion?: string } | null>
>();

export function fetchPublicIdentity(
  uid: string
): Promise<{ ecdh: CryptoKey; ecdsa: CryptoKey; keyVersion?: string } | null> {
  if (!publicKeyCache.has(uid)) {
    publicKeyCache.set(
      uid,
      (async () => {
        const snap = await get(ref(db, `publicKeys/${uid}`));
        if (!snap.exists()) return null;
        const val = snap.val() as PublicIdentity;

        const ecdh = await crypto.subtle.importKey(
          "jwk",
          val.ecdhPublicJwk,
          { name: "ECDH", namedCurve: "P-256" },
          true,
          []
        );
        const ecdsa = await crypto.subtle.importKey(
          "jwk",
          val.ecdsaPublicJwk,
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["verify"]
        );

        return { ecdh, ecdsa, keyVersion: val.keyVersion };
      })()
    );
  }
  return publicKeyCache.get(uid)!;
}

/**
 * Aktuelle Public-Key-Version eines Nutzers (siehe StoredIdentity-Kommentar
 * zu keyVersion) — dient dem Erkennen veralteter Channel-Key-Envelopes in
 * ensureUserInAllChannels, ohne dafür extra Firebase-Reads zu brauchen
 * (nutzt denselben Cache wie fetchPublicIdentity).
 */
export async function getPublicKeyVersion(uid: string): Promise<string | undefined> {
  const identity = await fetchPublicIdentity(uid);
  return identity?.keyVersion;
}

/* -----------------------------------------------------------
 * AES-GCM Verschlüsselung von Nachrichtentext
 * ---------------------------------------------------------*/

export type EncryptedPayload = { ciphertext: string; iv: string };

export async function encryptText(
  aesKey: CryptoKey,
  plaintext: string
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded
  );
  return { ciphertext: bufToBase64(ciphertext), iv: bufToBase64(iv.buffer) };
}

export async function decryptText(
  aesKey: CryptoKey,
  payload: EncryptedPayload
): Promise<string> {
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBuf(payload.iv) },
    aesKey,
    base64ToBuf(payload.ciphertext)
  );
  return new TextDecoder().decode(plainBuf);
}

/* -----------------------------------------------------------
 * Signieren / Verifizieren (Integrität)
 * ---------------------------------------------------------*/

export async function signText(uid: string, text: string): Promise<string> {
  const identity = await getOwnIdentity(uid);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.ecdsaPrivateKey,
    new TextEncoder().encode(text)
  );
  return bufToBase64(sig);
}

export async function verifyText(
  ecdsaPublicKey: CryptoKey,
  text: string,
  signatureB64: string
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      ecdsaPublicKey,
      base64ToBuf(signatureB64),
      new TextEncoder().encode(text)
    );
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------
 * Forward Secrecy für Channels: Perioden-Rekeying (fester Zeit-Bucket
 * statt Pro-Nachricht-Ratchet — für Gruppen bewusst einfacher gehalten,
 * ein echter Ratchet bräuchte ein eigenes Sender-Key-Schema).
 * ---------------------------------------------------------*/

/**
 * Liefert eine für beide Gesprächspartner unabhängig berechenbare
 * Epochen-ID (fester Zeit-Bucket) — kein Koordinations-Overhead nötig.
 */
export function epochIdForTimestamp(durationMs: number, at: number = Date.now()): string {
  return String(Math.floor(at / durationMs));
}

/* -----------------------------------------------------------
 * DMs (Legacy/Bootstrap): statisch abgeleiteter Schlüssel.
 * Dient als Fallback für Alt-Nachrichten ohne `periodId` UND als
 * Übergangs-Schlüssel für die allererste(n) Nachricht(en) einer neuen
 * Konversation, bevor die erste Ratchet-Periode (siehe unten) etabliert
 * ist — kein Sonderfall im Code nötig, weil Nachrichten ohne `periodId`
 * ohnehin einheitlich über diesen Pfad entschlüsselt werden.
 * ---------------------------------------------------------*/

export async function deriveDmKey(
  uid: string,
  otherUid: string
): Promise<CryptoKey | null> {
  const identity = await getOwnIdentity(uid);
  const other = await fetchPublicIdentity(otherUid);
  if (!other) return null;

  return crypto.subtle.deriveKey(
    { name: "ECDH", public: other.ecdh },
    identity.ecdhPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/* -----------------------------------------------------------
 * DMs: Symmetrischer Hash-Ratchet pro Nachricht + opportunistisches
 * periodisches DH-Rekeying (echte Forward Secrecy + Post-Compromise-
 * Security, vereinfacht gegenüber einem vollen Signal-Double-Ratchet —
 * siehe Plan-Kontext).
 * ---------------------------------------------------------*/

const DM_MAX_MESSAGES_PER_PERIOD = 50;
const DM_MAX_SKIPPED_KEYS = 50;

function bytesToBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

async function generateEphemeralKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
  // extractable: true gilt für das ganze Paar (Web Crypto kennt kein
  // getrenntes Flag pro Hälfte) — hier bewusst in Kauf genommen, da dieser
  // Schlüssel nur transient existiert (in IndexedDB nur bis zum Abschluss
  // des DH-Austauschs, danach sofort gelöscht) und nicht der langfristige
  // Identitäts-Schlüssel ist.
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk };
}

async function deriveRootFromEphemeralDH(
  myEphemeralPrivate: CryptoKey,
  otherEphemeralPublicJwk: JsonWebKey
): Promise<Uint8Array> {
  const otherPublic = await crypto.subtle.importKey(
    "jwk",
    otherEphemeralPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: otherPublic },
    myEphemeralPrivate,
    256
  );
  return new Uint8Array(bits);
}

async function hmacKeyFrom(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytesToBuf(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function hmac(keyBytes: Uint8Array, context: number): Promise<Uint8Array> {
  const key = await hmacKeyFrom(keyBytes);
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array([context]));
  return new Uint8Array(sig);
}

/** Ein Ratchet-Schritt: liefert den Message-Key für den aktuellen
 * Kettenschritt sowie den nächsten Kettenschlüssel. Der alte Kettenschlüssel
 * wird vom Aufrufer verworfen (Einweg-Funktion — daraus folgt Forward
 * Secrecy). */
async function ratchetStep(
  chainKeyBytes: Uint8Array
): Promise<{ messageKeyBytes: Uint8Array; nextChainKeyBytes: Uint8Array }> {
  const messageKeyBytes = await hmac(chainKeyBytes, 0x01);
  const nextChainKeyBytes = await hmac(chainKeyBytes, 0x02);
  return { messageKeyBytes, nextChainKeyBytes };
}

async function importMessageKey(messageKeyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytesToBuf(messageKeyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

function convIdFromIds(a: string, b: string): string {
  return [a, b].sort().join("__");
}

type ChainState = { chainKeyBytes: number[]; nextSeq: number };

/** Trennt die geteilte Ratchet-Wurzel einer DM-Periode in drei unabhängige
 * Ketten auf, damit Hauptnachrichten, Thread-Antworten und Reaktionen sich
 * nicht denselben `seq`-Zähler teilen (sonst könnten z. B. eine Nachricht
 * und eine kurz danach gesendete Reaktion denselben Message-Key erhalten). */
export type MsgCategory = "msg" | "thread" | "reaction";

/** Serialisiert konkurrierende Aufrufe für denselben Ketten-Zustand
 * (`getSendMessageKey`/`getReceiveMessageKey`), damit zwei nahezu
 * gleichzeitige Aufrufe nicht denselben `nextSeq` lesen und denselben
 * Message-Key doppelt vergeben. */
const chainLocks = new Map<string, Promise<unknown>>();
function withChainLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prior = chainLocks.get(lockKey) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  chainLocks.set(
    lockKey,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/**
 * Stellt sicher, dass für die Konversation eine nutzbare Ratchet-Periode
 * existiert, und liefert deren Wurzel-Bytes. Opportunistisch: blockiert
 * nicht, falls die Gegenseite gerade nicht reagiert hat — liefert dann
 * `null`, der Aufrufer fällt in dem Fall auf `deriveDmKey` zurück.
 */
export async function ensureDmPeriodRoot(
  myUid: string,
  otherUid: string
): Promise<{ periodId: string; rootBytes: Uint8Array } | null> {
  const convId = convIdFromIds(myUid, otherUid);

  // Ohne Sperre könnten zwei nahezu gleichzeitige Aufrufe (z. B. eine
  // Nachricht senden und kurz danach reagieren) beide feststellen, dass
  // keine nutzbare Periode existiert, und dann JEDER eine eigene neue
  // Periode mit potenziell identischer, `Date.now()`-basierter ID
  // anstoßen und sich dabei gegenseitig den `dmSessions`-Eintrag und den
  // lokal gecachten Ephemer-Schlüssel überschreiben — die am Ende
  // gecachte Wurzel passt dann nicht mehr zu dem, was die Gegenseite
  // tatsächlich vereinbart hat, und die Periode wird dauerhaft unlesbar.
  return withChainLock(`ensure:${convId}`, async () => {
    const hintSnap = await get(ref(db, `dmThreads/${myUid}/${otherUid}/currentPeriodId`));
    const hintedPeriodId = hintSnap.val() as string | null;

    let usable: { periodId: string; rootBytes: Uint8Array } | null = null;

    if (hintedPeriodId) {
      const root = await tryCompletePeriod(convId, hintedPeriodId, myUid, otherUid);
      if (root) {
        const state = await ratchetGet<ChainState>(
          `chain:${convId}:${hintedPeriodId}:${myUid}:msg`
        );
        if (!state || state.nextSeq < DM_MAX_MESSAGES_PER_PERIOD) {
          return { periodId: hintedPeriodId, rootBytes: root };
        }
        usable = { periodId: hintedPeriodId, rootBytes: root }; // stale, aber nutzbar als Fallback
      }
    }

    // Aktuelle Periode fehlt, ist unvollständig oder zu alt -> neue anstoßen,
    // dabei aber nicht auf die Gegenseite warten.
    const newPeriodId = String(Date.now());
    const eph = await generateEphemeralKeyPair();
    await ratchetPut(`pending:${convId}:${newPeriodId}`, eph.privateKey);
    await set(ref(db, `dmSessions/${convId}/${newPeriodId}/${myUid}`), {
      ephemeralPublicJwk: eph.publicJwk,
      createdAt: Date.now(),
    });
    await update(ref(db), {
      [`dmThreads/${myUid}/${otherUid}/currentPeriodId`]: newPeriodId,
      [`dmThreads/${otherUid}/${myUid}/currentPeriodId`]: newPeriodId,
    });

    const maybeCompleted = await tryCompletePeriod(convId, newPeriodId, myUid, otherUid);
    if (maybeCompleted) return { periodId: newPeriodId, rootBytes: maybeCompleted };

    return usable; // stale-aber-nutzbar, oder null (dann: deriveDmKey-Fallback)
  });
}

/**
 * Wurzel-Bytes für eine KONKRETE, bereits bekannte Periode (z. B. aus dem
 * `periodId`-Feld einer eintreffenden Nachricht) — im Gegensatz zu
 * `ensureDmPeriodRoot` wird hier NIE eine neue Periode angestoßen, nur eine
 * bereits laufende ggf. vervollständigt (falls man selbst die eingeladene
 * Gegenseite ist). Für das Entschlüsseln eintreffender Nachrichten gedacht.
 */
export async function getPeriodRoot(
  myUid: string,
  otherUid: string,
  periodId: string
): Promise<Uint8Array | null> {
  return tryCompletePeriod(convIdFromIds(myUid, otherUid), periodId, myUid, otherUid);
}

async function tryCompletePeriod(
  convId: string,
  periodId: string,
  myUid: string,
  otherUid: string
): Promise<Uint8Array | null> {
  // Eigene Sperre pro (convId, periodId): wird sowohl aus `ensureDmPeriodRoot`
  // (bereits per convId gesperrt) als auch unabhängig davon aus `getPeriodRoot`
  // beim Entschlüsseln eintreffender Nachrichten aufgerufen — mehrere
  // Nachrichten derselben, noch nicht abgeschlossenen Periode werden beim
  // Laden typischerweise per `Promise.all` parallel entschlüsselt, was ohne
  // diese Sperre zu genau demselben Überschreiben-Problem führen kann wie
  // in `ensureDmPeriodRoot` beschrieben.
  return withChainLock(`period:${convId}:${periodId}`, async () => {
    const cached = await ratchetGet<number[]>(`root:${convId}:${periodId}`);
    if (cached) return new Uint8Array(cached);

    const snap = await get(ref(db, `dmSessions/${convId}/${periodId}`));
    const val = snap.val() as Record<string, { ephemeralPublicJwk: JsonWebKey }> | null;

    // Ich bin die Gegenseite und wurde gerade erst eingeladen -> meinen
    // eigenen Ephemer-Schlüssel jetzt nachliefern.
    if (val?.[otherUid] && !val?.[myUid]) {
      const eph = await generateEphemeralKeyPair();
      await ratchetPut(`pending:${convId}:${periodId}`, eph.privateKey);
      await set(ref(db, `dmSessions/${convId}/${periodId}/${myUid}`), {
        ephemeralPublicJwk: eph.publicJwk,
        createdAt: Date.now(),
      });
    }

    const myPriv = await ratchetGet<CryptoKey>(`pending:${convId}:${periodId}`);
    if (!myPriv) return null;

    const finalVal =
      val?.[otherUid] != null
        ? val
        : ((await get(ref(db, `dmSessions/${convId}/${periodId}`))).val() as typeof val);
    const otherJwk = finalVal?.[otherUid]?.ephemeralPublicJwk;
    if (!otherJwk) return null;

    const rootBytes = await deriveRootFromEphemeralDH(myPriv, otherJwk);
    await ratchetPut(`root:${convId}:${periodId}`, Array.from(rootBytes));
    await ratchetDelete(`pending:${convId}:${periodId}`);
    return rootBytes;
  });
}

/** Nächsten Message-Key für eine EIGENE ausgehende Nachricht in dieser
 * Periode/Epoche (schreibt den fortgeschrittenen Kettenzustand persistent
 * zurück). `scopeId` ist der Geltungsbereich der Ratchet-Kette — bei DMs die
 * `convId` (beide Teilnehmer), bei Channels die `channelId` (alle
 * Mitglieder) — und `senderUid` die eigene UID (man leitet immer nur die
 * eigene Sende-Kette ab). Generisch genug, um von DMs UND Channels benutzt
 * zu werden, statt zwei parallele Ratchet-Implementierungen zu pflegen. */
export async function getSendMessageKey(
  scopeId: string,
  senderUid: string,
  periodId: string,
  rootBytes: Uint8Array,
  category: MsgCategory = "msg"
): Promise<{ key: CryptoKey; seq: number }> {
  const stateKey = `chain:${scopeId}:${periodId}:${senderUid}:${category}`;

  return withChainLock(stateKey, async () => {
    let state = await ratchetGet<ChainState>(stateKey);
    if (!state) {
      state = {
        chainKeyBytes: Array.from(await chain0For(rootBytes, senderUid, category)),
        nextSeq: 0,
      };
    }

    const { messageKeyBytes, nextChainKeyBytes } = await ratchetStep(
      new Uint8Array(state.chainKeyBytes)
    );
    const seq = state.nextSeq;
    await ratchetPut(stateKey, {
      chainKeyBytes: Array.from(nextChainKeyBytes),
      nextSeq: seq + 1,
    });

    // Eigene ausgehende Nachrichten laufen beim Anzeigen trotzdem durch den
    // normalen Entschlüsselungspfad (kein optimistisches lokales Echo) — die
    // Sendekette hat den Schlüssel für diesen `seq` aber bereits verbraucht
    // und vergessen (das ist der Sinn von Forward Secrecy). Deshalb hier
    // zusätzlich im selben "Skipped-Key"-Cache ablegen, den
    // getReceiveMessageKey ohnehin zuerst prüft — so kann man die eigene
    // gerade gesendete Nachricht noch einmal lesen, ohne die Ratchet-
    // Garantien für alle anderen (vergangenen) Nachrichten aufzuweichen.
    await ratchetPut(
      `skip:${scopeId}:${periodId}:${senderUid}:${category}:${seq}`,
      Array.from(messageKeyBytes)
    );

    return { key: await importMessageKey(messageKeyBytes), seq };
  });
}

/** Message-Key für eine EMPFANGENE Nachricht von `senderUid` bei
 * gegebenem `seq` — spult die mitverfolgte Kette bei Bedarf vor und
 * cached dabei übersprungene Schlüssel für später eintreffende, ältere
 * Nachrichten. Gleiches `scopeId`-Prinzip wie `getSendMessageKey`. */
export async function getReceiveMessageKey(
  scopeId: string,
  senderUid: string,
  periodId: string,
  rootBytes: Uint8Array,
  seq: number,
  category: MsgCategory = "msg"
): Promise<CryptoKey | null> {
  const stateKey = `chain:${scopeId}:${periodId}:${senderUid}:${category}`;

  return withChainLock(stateKey, async () => {
    const skippedKey = `skip:${scopeId}:${periodId}:${senderUid}:${category}:${seq}`;
    const skipped = await ratchetGet<number[]>(skippedKey);
    if (skipped) {
      await ratchetDelete(skippedKey);
      return importMessageKey(new Uint8Array(skipped));
    }

    let state = await ratchetGet<ChainState>(stateKey);
    if (!state) {
      state = {
        chainKeyBytes: Array.from(await chain0For(rootBytes, senderUid, category)),
        nextSeq: 0,
      };
    }

    if (seq < state.nextSeq) return null; // bereits verbraucht/verworfen, nicht mehr rekonstruierbar
    if (seq - state.nextSeq > DM_MAX_SKIPPED_KEYS) return null; // Sprung zu groß, bewusste Grenze

    let chainKeyBytes: Uint8Array = new Uint8Array(state.chainKeyBytes);
    let nextSeq = state.nextSeq;
    let resultKeyBytes: Uint8Array | null = null;

    while (nextSeq <= seq) {
      const { messageKeyBytes, nextChainKeyBytes } = await ratchetStep(chainKeyBytes);
      if (nextSeq === seq) {
        resultKeyBytes = messageKeyBytes;
      } else {
        await ratchetPut(
          `skip:${scopeId}:${periodId}:${senderUid}:${category}:${nextSeq}`,
          Array.from(messageKeyBytes)
        );
      }
      chainKeyBytes = nextChainKeyBytes;
      nextSeq++;
    }

    await ratchetPut(stateKey, { chainKeyBytes: Array.from(chainKeyBytes), nextSeq });
    return resultKeyBytes ? importMessageKey(resultKeyBytes) : null;
  });
}

/* -----------------------------------------------------------
 * Persistenter Klartext-Cache für geratchete DM-Nachrichten/Reaktionen:
 * jeder Message-Key wird nach Gebrauch verworfen (Forward Secrecy), die App
 * entschlüsselt aber bei jedem Firebase-Snapshot die komplette Liste neu —
 * ohne diesen Cache würde jede bereits gelesene Nachricht beim nächsten
 * Rendern dauerhaft unlesbar werden. Läuft über denselben generischen
 * `ratchetState`-Store, nur mit eigenem Namensraum.
 * ---------------------------------------------------------*/

export type CachedPlaintext = { text: string; verified?: boolean };

export async function getCachedPlaintext(
  scopeId: string,
  kind: "msg" | "reaction" | "thread",
  id: string
): Promise<CachedPlaintext | undefined> {
  return ratchetGet<CachedPlaintext>(`pt:${scopeId}:${kind}:${id}`);
}

export async function setCachedPlaintext(
  scopeId: string,
  kind: "msg" | "reaction" | "thread",
  id: string,
  value: CachedPlaintext
): Promise<void> {
  await ratchetPut(`pt:${scopeId}:${kind}:${id}`, value);
}

async function chain0For(
  rootBytes: Uint8Array,
  senderUid: string,
  category: MsgCategory
): Promise<Uint8Array> {
  // Eigener HMAC-Schritt mit Sender-UID + Kategorie als Kontext: Sender-UID
  // sorgt dafür, dass A->B und B->A trotz gemeinsamer Wurzel unterschiedliche
  // Ketten ergeben (ohne vorherige Rollenaushandlung), die Kategorie sorgt
  // zusätzlich dafür, dass Hauptnachrichten, Thread-Antworten und Reaktionen
  // unabhängige Ketten benutzen statt sich einen `seq`-Zähler zu teilen.
  const key = await hmacKeyFrom(rootBytes);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`chain:${senderUid}:${category}`)
  );
  return new Uint8Array(sig);
}

/* -----------------------------------------------------------
 * Channels: Envelope-Encryption eines gemeinsamen Channel-Keys
 * ---------------------------------------------------------*/

export type ChannelKeyEnvelope = {
  ephemeralPublicJwk: JsonWebKey;
  wrappedKey: string;
  iv: string;
  forKeyVersion?: string;
};

export async function generateChannelKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Verpackt einen Channel-Key für ein bestimmtes Mitglied (ECIES-artig). */
export async function wrapChannelKeyForMember(
  channelKey: CryptoKey,
  memberUid: string
): Promise<ChannelKeyEnvelope | null> {
  const member = await fetchPublicIdentity(memberUid);
  if (!member) return null;

  const ephemeralPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );

  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: member.ecdh },
    ephemeralPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey(
    "raw",
    channelKey,
    wrappingKey,
    { name: "AES-GCM", iv }
  );

  const ephemeralPublicJwk = await crypto.subtle.exportKey(
    "jwk",
    ephemeralPair.publicKey
  );

  return {
    ephemeralPublicJwk,
    wrappedKey: bufToBase64(wrapped),
    iv: bufToBase64(iv.buffer),
    ...(member.keyVersion ? { forKeyVersion: member.keyVersion } : {}),
  };
}

/** Entpackt einen Channel-Key mit dem eigenen privaten ECDH-Key. */
export async function unwrapChannelKey(
  uid: string,
  envelope: ChannelKeyEnvelope
): Promise<CryptoKey> {
  const identity = await getOwnIdentity(uid);

  const ephemeralPublicKey = await crypto.subtle.importKey(
    "jwk",
    envelope.ephemeralPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: ephemeralPublicKey },
    identity.ecdhPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["unwrapKey"]
  );

  return crypto.subtle.unwrapKey(
    "raw",
    base64ToBuf(envelope.wrappedKey),
    wrappingKey,
    { name: "AES-GCM", iv: base64ToBuf(envelope.iv) },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
