import { ref, get, set, update, push } from "firebase/database";
import { db } from "@/app/lib/firebase";

export const HOME_SERVER_ID = "home";

// Nur dieser Account darf den HomeServer einmalig anlegen — ohne Cloud
// Functions/Admin-SDK gibt es keinen anderen verlässlichen Weg, das
// deterministisch statt "wer als Erstes nach diesem Deploy einloggt" zu
// entscheiden.
const HOME_SERVER_OWNER_EMAIL = "christian.pressig@web.de";

const HOME_CHANNELS: { name: string; description: string }[] = [
  { name: "willkommen", description: "Willkommen bei Cryptflow! Schau hier zuerst vorbei." },
  { name: "regeln", description: "Die Regeln für den Umgang miteinander auf diesem Server." },
  { name: "ankuendigungen", description: "Neuigkeiten und Updates rund um Cryptflow." },
  { name: "allgemein", description: "Allgemeiner Chat für alles Mögliche." },
  { name: "feedback-ideen", description: "Feedback, Bugs und Ideen für Cryptflow." },
];

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

export async function joinHomeServerIfNeeded(uid: string): Promise<void> {
  try {
    // NICHT vorab servers/{HOME_SERVER_ID} lesen: dessen .read-Regel
    // verlangt (sobald der Server existiert) bereits Mitgliedschaft — für
    // ein frisches Konto wäre das ein Henne-Ei-Problem (PERMISSION_DENIED
    // vor dem eigentlichen Beitritt). Die eigene serverMembers/{id}/{uid}-
    // Zeile ist dagegen immer für die eigene uid lesbar.
    const memberSnap = await get(ref(db, `serverMembers/${HOME_SERVER_ID}/${uid}`));
    if (memberSnap.exists()) return;

    await update(ref(db), {
      [`serverMembers/${HOME_SERVER_ID}/${uid}`]: { role: "member", joinedAt: Date.now() },
      [`userServers/${uid}/${HOME_SERVER_ID}`]: true,
    });
  } catch (e) {
    console.error("[homeServer] Automatischer Beitritt fehlgeschlagen:", e);
  }
}
