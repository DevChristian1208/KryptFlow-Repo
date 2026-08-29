import { ref, get, set, update, push } from "firebase/database";
import { db } from "@/app/lib/firebase";

/**
 * Der "Cryptflow HomeServer" — fester, gut lesbarer Schlüssel statt einer
 * zufälligen ID, damit der Client ihn wiedererkennen und (a) einmalig
 * anlegen sowie (b) neue Konten automatisch beitreten lassen kann.
 */
export const HOME_SERVER_ID = "home";

// Nur dieser Account darf den HomeServer einmalig anlegen (und wird damit
// automatisch dessen Owner) — ohne Cloud Functions/Admin-SDK gibt es keinen
// anderen verlässlichen Weg, das deterministisch statt "wer als Erstes nach
// diesem Deploy einloggt" zu entscheiden.
const HOME_SERVER_OWNER_EMAIL = "christian.pressig@web.de";

const HOME_CHANNELS: { name: string; description: string }[] = [
  { name: "willkommen", description: "Willkommen bei Cryptflow! Schau hier zuerst vorbei." },
  { name: "regeln", description: "Die Regeln für den Umgang miteinander auf diesem Server." },
  { name: "ankuendigungen", description: "Neuigkeiten und Updates rund um Cryptflow." },
  { name: "allgemein", description: "Allgemeiner Chat für alles Mögliche." },
  { name: "feedback-ideen", description: "Feedback, Bugs und Ideen für Cryptflow." },
];

/**
 * Legt den HomeServer inkl. Standard-Channels an, falls er noch nicht
 * existiert — einmalig, ausgelöst vom designierten Owner-Account beim
 * nächsten Login. Danach übernimmt ensureNewAccountJoinsHomeServer für alle
 * anderen Accounts nur noch den Beitritt.
 */
export async function ensureHomeServerBootstrapped(
  uid: string,
  email: string | null
): Promise<void> {
  if (email !== HOME_SERVER_OWNER_EMAIL) return;

  const existing = await get(ref(db, `servers/${HOME_SERVER_ID}`));
  if (existing.exists()) return;

  const createdAt = Date.now();

  await set(ref(db, `servers/${HOME_SERVER_ID}`), {
    name: "Cryptflow HomeServer",
    ownerUid: uid,
    createdAt,
  });

  await update(ref(db), {
    [`serverMembers/${HOME_SERVER_ID}/${uid}`]: { role: "owner", joinedAt: createdAt },
    [`userServers/${uid}/${HOME_SERVER_ID}`]: true,
  });

  const channelUpdates: Record<string, unknown> = {};
  for (const ch of HOME_CHANNELS) {
    const channelId = push(ref(db, "channels")).key!;
    channelUpdates[`channels/${channelId}`] = {
      name: ch.name,
      description: ch.description,
      createdAt,
      createdByEmail: email,
      public: true,
      serverId: HOME_SERVER_ID,
      restricted: false,
      members: { [uid]: true },
    };
  }
  await update(ref(db), channelUpdates);
}

/**
 * Lässt ein (nicht-Owner-)Konto dem HomeServer automatisch beitreten, falls
 * es noch nicht Mitglied ist — für jeden, der die Konto-Einrichtung
 * abschließt (SelectAvatar), sowohl frisch registrierte als auch Gäste.
 * Best-effort: existiert der HomeServer (noch) nicht (Owner war noch nicht
 * eingeloggt) oder schlägt der Beitritt fehl, bricht das die eigentliche
 * Konto-Einrichtung nicht ab.
 */
export async function joinHomeServerIfNeeded(uid: string): Promise<void> {
  try {
    const [serverSnap, memberSnap] = await Promise.all([
      get(ref(db, `servers/${HOME_SERVER_ID}`)),
      get(ref(db, `serverMembers/${HOME_SERVER_ID}/${uid}`)),
    ]);
    if (!serverSnap.exists() || memberSnap.exists()) return;

    await update(ref(db), {
      [`serverMembers/${HOME_SERVER_ID}/${uid}`]: { role: "member", joinedAt: Date.now() },
      [`userServers/${uid}/${HOME_SERVER_ID}`]: true,
    });
  } catch (e) {
    console.error("[homeServer] Automatischer Beitritt fehlgeschlagen:", e);
  }
}
