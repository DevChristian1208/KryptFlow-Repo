import { ref, get, set, update } from "firebase/database";
import { db } from "@/app/lib/firebase";

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

async function ratchetGetAllByPrefixes(
  prefixes: string[]
): Promise<{ key: string; value: unknown }[]> {
  const dbi = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_RATCHET_STORE, "readonly");
    const req = tx.objectStore(IDB_RATCHET_STORE).openCursor();
    const out: { key: string; value: unknown }[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      const entry = cursor.value as { key: string; value: unknown };
      if (prefixes.some((p) => entry.key.startsWith(p))) out.push(entry);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// Überschreibt nie frischeren lokalen Zustand — ein wiederhergestellter
// Snapshot darf bestehende, weiter fortgeschrittene Ratchet-Ketten nicht
// zurückdrehen.
async function ratchetPutManyIfAbsent(
  entries: { key: string; value: unknown }[]
): Promise<void> {
  const dbi = await openIdb();
  await Promise.all(
    entries.map(
      (entry) =>
        new Promise<void>((resolve, reject) => {
          const tx = dbi.transaction(IDB_RATCHET_STORE, "readwrite");
          const store = tx.objectStore(IDB_RATCHET_STORE);
          const getReq = store.get(entry.key);
          getReq.onsuccess = () => {
            if (getReq.result === undefined) store.put(entry);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    )
  );
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

export function bufToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export type EncryptedBlob = {
  ciphertext: Blob;
  ivB64: string;
  keyB64: string;
  contentType: string;
};

export async function encryptBlob(file: Blob): Promise<EncryptedBlob> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = await file.arrayBuffer();
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const rawKey = await crypto.subtle.exportKey("raw", key);
  return {
    ciphertext: new Blob([ciphertext], { type: "application/octet-stream" }),
    ivB64: bufToBase64(iv.buffer),
    keyB64: bufToBase64(rawKey),
    contentType: file.type || "application/octet-stream",
  };
}

export async function decryptBlob(
  ciphertext: ArrayBuffer,
  ivB64: string,
  keyB64: string,
  contentType: string
): Promise<Blob> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBuf(keyB64),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBuf(ivB64) },
    key,
    ciphertext
  );
  return new Blob([plaintext], { type: contentType });
}

export type PublicIdentity = {
  ecdhPublicJwk: JsonWebKey;
  ecdsaPublicJwk: JsonWebKey;
  keyVersion?: string;
};

async function generateIdentity(uid: string): Promise<StoredIdentity> {
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

// Schützt vor gleichzeitigen, doppelten Aufrufen für dieselbe uid: ohne diese
// Sperre könnten zwei parallele Aufrufe beide "noch keine Identität"
// feststellen, JEDER unabhängig ein eigenes Schlüsselpaar erzeugen — lokal
// gespeicherter privater Schlüssel und veröffentlichter öffentlicher
// Schlüssel passen danach dauerhaft nicht mehr zusammen.
const ensureIdentityKeysInFlight = new Map<string, Promise<void>>();

export function ensureIdentityKeys(uid: string): Promise<void> {
  const existing = ensureIdentityKeysInFlight.get(uid);
  if (existing) return existing;

  // navigator.locks serialisiert zusätzlich ECHT über mehrere Tabs/Fenster
  // derselben Origin hinweg (die Map oben schützt nur innerhalb dieses Tabs).
  // Fallback ohne Lock für Browser ohne Web-Locks-Support.
  const withCrossTabLock: (fn: () => Promise<void>) => Promise<void> =
    typeof navigator !== "undefined" && "locks" in navigator
      ? (fn) => navigator.locks.request(`cryptflow-identity:${uid}`, fn)
      : (fn) => fn();

  const run = withCrossTabLock(async () => {
    let identity = await idbGet(uid);
    const justGenerated = !identity;

    if (!identity) {
      identity = await generateIdentity(uid);
      await idbPut(identity);
    }

    const publishedExists = justGenerated
      ? false
      : (await get(ref(db, `publicKeys/${uid}`))).exists();

    if (justGenerated || !publishedExists) {
      const ecdhPublicJwk = await crypto.subtle.exportKey("jwk", identity.ecdhPublicKey);
      const ecdsaPublicJwk = await crypto.subtle.exportKey("jwk", identity.ecdsaPublicKey);
      const keyVersion = crypto.randomUUID();
      await set(ref(db, `publicKeys/${uid}`), {
        ecdhPublicJwk,
        ecdsaPublicJwk,
        keyVersion,
      });
      invalidatePublicKeyCache(uid);
    }
  });

  ensureIdentityKeysInFlight.set(uid, run);
  run.finally(() => {
    ensureIdentityKeysInFlight.delete(uid);
  });
  return run;
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

  // "pending:…"-Einträge (offene Ephemer-Schlüssel einer gerade erst
  // begonnenen Periode) werden bewusst NICHT gesichert — CryptoKey-Objekte,
  // lösen sich im Normalfall ohnehin innerhalb von Sekunden von selbst auf.
  const ratchetSnapshot = await ratchetGetAllByPrefixes(["root:", "pt:"]);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, BACKUP_PBKDF2_ITERATIONS);

  const plaintext = new TextEncoder().encode(
    JSON.stringify({ ecdhPrivateJwk, ecdsaPrivateJwk, ratchetSnapshot })
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

  const { ecdhPrivateJwk, ecdsaPrivateJwk, ratchetSnapshot } = JSON.parse(
    new TextDecoder().decode(plaintext)
  ) as {
    ecdhPrivateJwk: JsonWebKey;
    ecdsaPrivateJwk: JsonWebKey;
    ratchetSnapshot?: { key: string; value: unknown }[];
  };

  // WICHTIG, zwei Stolperfallen zugleich (Ursache eines vergangenen Bugs,
  // bei dem restoreIdentityBackup() JEDES Mal fehlschlug und danach still
  // eine komplett neue, unabhängige Identität erzeugt wurde):
  // 1) "d: undefined" per Objekt-Spread lässt "d" als EIGENE Property mit
  //    Wert undefined zurück ("d" in obj ist dann immer noch true) — die
  //    WebCrypto-JWK-Prüfung auf "ist ein privater Schlüssel vorhanden"
  //    prüft genau diese Objekt-Eigenschaft, nicht den Wert. "d" muss also
  //    per delete komplett entfernt werden, nicht nur auf undefined gesetzt.
  // 2) "key_ops: []" (leeres Array) wird von der JWK-Spezifikation als
  //    "für dieses JWK sind GAR KEINE Operationen erlaubt" gelesen — das
  //    widerspricht dann jeder angeforderten Nutzung (z. B. "verify") und
  //    importKey() bricht mit "Key operations and usage mismatch" ab. Auch
  //    "key_ops" muss komplett entfernt werden statt auf [] gesetzt.
  const ecdhPublicJwk: JsonWebKey = { ...ecdhPrivateJwk };
  delete ecdhPublicJwk.d;
  delete ecdhPublicJwk.key_ops;
  const ecdsaPublicJwk: JsonWebKey = { ...ecdsaPrivateJwk };
  delete ecdsaPublicJwk.d;
  delete ecdsaPublicJwk.key_ops;

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

  if (ratchetSnapshot?.length) {
    await ratchetPutManyIfAbsent(ratchetSnapshot);
  }
}

export async function mergeRatchetBackupSnapshot(
  uid: string,
  passphrase: string
): Promise<void> {
  try {
    const snap = await get(ref(db, `encryptedKeyBackup/${uid}`));
    if (!snap.exists()) return;
    const backup = snap.val() as KeyBackup;

    const salt = new Uint8Array(base64ToBuf(backup.saltB64));
    const key = await deriveBackupKey(passphrase, salt, backup.iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBuf(backup.ivB64) },
      key,
      base64ToBuf(backup.ciphertextB64)
    );
    const { ratchetSnapshot } = JSON.parse(new TextDecoder().decode(plaintext)) as {
      ratchetSnapshot?: { key: string; value: unknown }[];
    };
    if (ratchetSnapshot?.length) {
      await ratchetPutManyIfAbsent(ratchetSnapshot);
    }
  } catch (e) {
    console.warn("[crypto] Ratchet-Snapshot-Merge übersprungen:", e);
  }
}

export async function hasKeyBackup(uid: string): Promise<boolean> {
  const snap = await get(ref(db, `encryptedKeyBackup/${uid}`));
  return snap.exists();
}

export async function hasLocalIdentity(uid: string): Promise<boolean> {
  return !!(await idbGet(uid));
}

export async function needsIdentityRecoveryPrompt(uid: string): Promise<boolean> {
  if (await hasLocalIdentity(uid)) return false;
  return hasKeyBackup(uid);
}

async function localIdentityMatchesPublished(uid: string): Promise<boolean> {
  const identity = await idbGet(uid);
  if (!identity) return false;
  const published = await fetchPublicIdentity(uid, { bypassCache: true });
  if (!published) return false;
  const [localJwk, publishedJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", identity.ecdsaPublicKey),
    crypto.subtle.exportKey("jwk", published.ecdsa),
  ]);
  return localJwk.x === publishedJwk.x && localJwk.y === publishedJwk.y;
}

export async function ensureIdentityAndAutoBackup(
  uid: string,
  password: string
): Promise<void> {
  if (!(await hasLocalIdentity(uid))) {
    try {
      await restoreIdentityBackup(uid, password);
      await republishOwnPublicKey(uid);
    } catch (e) {
      console.warn(
        "[crypto] Automatische Wiederherstellung nicht möglich, erzeuge neue Identität:",
        e
      );
    }
  } else {
    await mergeRatchetBackupSnapshot(uid, password);

    // Selbstheilung gegen genau das Muster, das die wiederkehrenden
    // "Signatur ungültig"/"Kein Schlüssel"-Vorfälle verursacht hat: eine
    // lokale Identität kann vorhanden, aber (z. B. durch einen früher
    // fehlgeschlagenen restoreIdentityBackup-Versuch in einer anderen
    // Sitzung) NICHT mehr dieselbe sein wie die veröffentlichte — bislang
    // prüfte ensureIdentityKeys() unten nur "existiert lokal etwas" und
    // "existiert veröffentlicht etwas", nie ob beide zusammenpassen. Ohne
    // diesen Abgleich signiert/entschlüsselt das Gerät für immer mit dem
    // falschen Schlüssel, ohne dass es je auffällt. Erst mit dem gerade
    // eingegebenen Passwort das (vermutlich aktuellere) Backup wiederholen;
    // passt das Ergebnis danach immer noch nicht zur veröffentlichten
    // Identität, gilt dieses Gerät als Quelle der Wahrheit.
    if (!(await localIdentityMatchesPublished(uid))) {
      let healed = false;
      try {
        await restoreIdentityBackup(uid, password);
        healed = await localIdentityMatchesPublished(uid);
      } catch (e) {
        console.warn(
          "[crypto] Identitäts-Abgleich: Wiederherstellung aus Backup fehlgeschlagen:",
          e
        );
      }
      if (!healed) {
        await republishOwnPublicKey(uid);
      }
    }
  }

  await ensureIdentityKeys(uid);

  try {
    await exportIdentityBackup(uid, password);
  } catch (e) {
    console.error("[crypto] Automatisches Schlüssel-Backup fehlgeschlagen:", e);
  }
}

export async function republishOwnPublicKey(uid: string): Promise<void> {
  const identity = await getOwnIdentity(uid);
  const ecdhPublicJwk = await crypto.subtle.exportKey("jwk", identity.ecdhPublicKey);
  const ecdsaPublicJwk = await crypto.subtle.exportKey("jwk", identity.ecdsaPublicKey);
  const keyVersion = crypto.randomUUID();
  await set(ref(db, `publicKeys/${uid}`), { ecdhPublicJwk, ecdsaPublicJwk, keyVersion });
  invalidatePublicKeyCache(uid);
}

const PUBLIC_KEY_CACHE_TTL_MS = 60_000;

const publicKeyCache = new Map<
  string,
  {
    fetchedAt: number;
    promise: Promise<{ ecdh: CryptoKey; ecdsa: CryptoKey; keyVersion?: string } | null>;
  }
>();

// TTL statt für immer gültigem Cache: ändert sich die Identität eines
// Nutzers zwischenzeitlich, würde ein unbegrenzt gültiger Cache hier
// weiterhin den ALTEN öffentlichen Schlüssel liefern — Signaturen und neue
// Envelope-Wraps würden dann gegen den falschen Schlüssel geprüft/erzeugt,
// obwohl der Absender tatsächlich korrekt mit seiner aktuellen Identität
// signiert/verschlüsselt hat. Das war die Ursache mehrerer "Signatur
// ungültig"-Vorfälle.
export function fetchPublicIdentity(
  uid: string,
  opts?: { bypassCache?: boolean }
): Promise<{ ecdh: CryptoKey; ecdsa: CryptoKey; keyVersion?: string } | null> {
  const cached = opts?.bypassCache ? undefined : publicKeyCache.get(uid);
  if (cached && Date.now() - cached.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
    return cached.promise;
  }

  const startedAt = Date.now();
  const promise = (async () => {
    const snap = await get(ref(db, `publicKeys/${uid}`));
    if (!snap.exists()) {
      // Nicht cachen: sonst bliebe "kein Schlüssel" für die volle TTL hängen,
      // selbst wenn der Nutzer (z. B. gerade erst kontaktierte Fremde, deren
      // ensureIdentityKeys() noch läuft) Sekundenbruchteile später doch
      // veröffentlicht wird. Nur den eigenen Eintrag löschen, nicht einen
      // zwischenzeitlich von einem anderen (z. B. bypassCache-)Aufruf neu
      // gesetzten.
      if (publicKeyCache.get(uid)?.fetchedAt === startedAt) {
        publicKeyCache.delete(uid);
      }
      return null;
    }
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
  })();

  publicKeyCache.set(uid, { fetchedAt: startedAt, promise });
  return promise;
}

// Muss direkt nach JEDEM eigenen Publish nach publicKeys/{uid} aufgerufen
// werden — sonst könnte der eigene Client innerhalb des TTL-Fensters noch
// den alten Public Key aus dem Cache benutzen, um z. B. einen Channel-Key
// für sich selbst zu wrappen oder eine Signatur zu prüfen, was dann mit dem
// gerade veröffentlichten NEUEN privaten Schlüssel fehlschlägt.
export function invalidatePublicKeyCache(uid: string): void {
  publicKeyCache.delete(uid);
}

export async function getPublicKeyVersion(
  uid: string,
  opts?: { bypassCache?: boolean }
): Promise<string | undefined> {
  const identity = await fetchPublicIdentity(uid, opts);
  return identity?.keyVersion;
}

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

export function epochIdForTimestamp(durationMs: number, at: number = Date.now()): string {
  return String(Math.floor(at / durationMs));
}

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

export type MsgCategory = "msg" | "thread" | "reaction";

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

export async function ensureDmPeriodRoot(
  myUid: string,
  otherUid: string
): Promise<{ periodId: string; rootBytes: Uint8Array } | null> {
  const convId = convIdFromIds(myUid, otherUid);

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
        usable = { periodId: hintedPeriodId, rootBytes: root };
      }
    }

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

    return usable;
  });
}

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
  return withChainLock(`period:${convId}:${periodId}`, async () => {
    const cached = await ratchetGet<number[]>(`root:${convId}:${periodId}`);
    if (cached) return new Uint8Array(cached);

    const snap = await get(ref(db, `dmSessions/${convId}/${periodId}`));
    const val = snap.val() as Record<string, { ephemeralPublicJwk: JsonWebKey }> | null;

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

    // Auch im Skipped-Key-Cache ablegen (denselben, den getReceiveMessageKey
    // zuerst prüft), damit man die eigene gerade gesendete Nachricht beim
    // Rendern noch einmal lesen kann, ohne die Forward-Secrecy-Garantien für
    // alle anderen Nachrichten aufzuweichen.
    await ratchetPut(
      `skip:${scopeId}:${periodId}:${senderUid}:${category}:${seq}`,
      Array.from(messageKeyBytes)
    );

    return { key: await importMessageKey(messageKeyBytes), seq };
  });
}

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

    if (seq < state.nextSeq) return null;
    if (seq - state.nextSeq > DM_MAX_SKIPPED_KEYS) return null;

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
  const key = await hmacKeyFrom(rootBytes);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`chain:${senderUid}:${category}`)
  );
  return new Uint8Array(sig);
}

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

export async function wrapChannelKeyForMember(
  channelKey: CryptoKey,
  memberUid: string,
  opts?: { bypassCache?: boolean }
): Promise<ChannelKeyEnvelope | null> {
  const member = await fetchPublicIdentity(memberUid, opts);
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

export type SelfEncrypted = EncryptedPayload & { keyEnvelope: ChannelKeyEnvelope };

export async function encryptForSelf(
  uid: string,
  plaintext: string
): Promise<SelfEncrypted> {
  const key = await generateChannelKey();
  const keyEnvelope = await wrapChannelKeyForMember(key, uid);
  if (!keyEnvelope) throw new Error("Eigener Public Key nicht verfügbar.");
  const { ciphertext, iv } = await encryptText(key, plaintext);
  return { ciphertext, iv, keyEnvelope };
}

export async function decryptForSelf(
  uid: string,
  payload: SelfEncrypted
): Promise<string> {
  const key = await unwrapChannelKey(uid, payload.keyEnvelope);
  return decryptText(key, { ciphertext: payload.ciphertext, iv: payload.iv });
}
