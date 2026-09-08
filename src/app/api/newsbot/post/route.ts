import { NextResponse } from "next/server";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { ref, get, push, update } from "firebase/database";
import { auth, db } from "@/app/lib/firebase";
import {
  importBotPrivateKeys,
  unwrapChannelKeyServer,
  encryptTextServer,
  signTextServer,
  epochIdForTimestampServer,
} from "@/app/lib/botCrypto";
import type { ChannelKeyEnvelope } from "@/app/lib/crypto";

// Vom Admin manuell ausgelöst (siehe NewsBotSetupModal / ServerSettingsModal)
// — postet einen kurzen Hacker-News-Digest in den #news-Channel, verschlüsselt
// mit den Zugangsdaten/Schlüsseln des Bot-Accounts (siehe botCrypto.ts).
// Kann später zusätzlich per externem Scheduler (z. B. Vercel Cron) auf
// diese Route zeigen, sobald das Projekt deployt ist.

const HN_TOP_STORIES = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const STORY_COUNT = 5;

type HnItem = { id: number; title?: string; url?: string; score?: number };

async function fetchDigest(): Promise<string> {
  const idsRes = await fetch(HN_TOP_STORIES);
  if (!idsRes.ok) throw new Error("Hacker News nicht erreichbar.");
  const ids = ((await idsRes.json()) as number[]).slice(0, STORY_COUNT);

  const items = await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(HN_ITEM(id));
      if (!res.ok) return null;
      return (await res.json()) as HnItem;
    })
  );

  const lines = items
    .filter((i): i is HnItem => !!i?.title)
    .map(
      (i, idx) =>
        `${idx + 1}. ${i.title}${i.url ? `\n${i.url}` : ""}`
    );

  const dateLabel = new Date().toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  return `📰 Tech-News vom ${dateLabel} (Hacker News)\n\n${lines.join("\n\n")}`;
}

export async function POST() {
  const {
    NEWSBOT_EMAIL,
    NEWSBOT_PASSWORD,
    NEWSBOT_UID,
    NEWSBOT_CHANNEL_ID,
    NEWSBOT_ECDH_PRIVATE_JWK,
    NEWSBOT_ECDSA_PRIVATE_JWK,
  } = process.env;

  if (
    !NEWSBOT_EMAIL ||
    !NEWSBOT_PASSWORD ||
    !NEWSBOT_UID ||
    !NEWSBOT_CHANNEL_ID ||
    !NEWSBOT_ECDH_PRIVATE_JWK ||
    !NEWSBOT_ECDSA_PRIVATE_JWK
  ) {
    return NextResponse.json(
      { error: "News-Bot ist nicht konfiguriert (Umgebungsvariablen fehlen)." },
      { status: 500 }
    );
  }

  try {
    const digest = await fetchDigest();

    await signInWithEmailAndPassword(auth, NEWSBOT_EMAIL, NEWSBOT_PASSWORD);

    const epochId = epochIdForTimestampServer();
    const envelopeSnap = await get(
      ref(db, `channelKeyEpochs/${NEWSBOT_CHANNEL_ID}/${epochId}/${NEWSBOT_UID}`)
    );
    if (!envelopeSnap.exists()) {
      await signOut(auth).catch(() => {});
      return NextResponse.json(
        {
          error:
            "Noch kein Channel-Schlüssel für den Bot hinterlegt. Öffne die App kurz mit einem eingeloggten Admin-Account (liefert den Schlüssel automatisch nach) und versuche es erneut.",
        },
        { status: 409 }
      );
    }

    const { ecdhPrivateKey, ecdsaPrivateKey } = await importBotPrivateKeys(
      JSON.parse(NEWSBOT_ECDH_PRIVATE_JWK),
      JSON.parse(NEWSBOT_ECDSA_PRIVATE_JWK)
    );
    const channelKey = await unwrapChannelKeyServer(
      ecdhPrivateKey,
      envelopeSnap.val() as ChannelKeyEnvelope
    );

    const { ciphertext, iv } = await encryptTextServer(channelKey, digest);
    const signature = await signTextServer(ecdsaPrivateKey, ciphertext);

    const msgRef = push(ref(db, `channelMessages/${NEWSBOT_CHANNEL_ID}`));
    await update(ref(db), {
      [`channelMessages/${NEWSBOT_CHANNEL_ID}/${msgRef.key}`]: {
        ciphertext,
        iv,
        senderUid: NEWSBOT_UID,
        signature,
        createdAt: Date.now(),
        epochId,
      },
    });

    await signOut(auth).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[newsbot/post] fehlgeschlagen:", e);
    await signOut(auth).catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Posten fehlgeschlagen." },
      { status: 500 }
    );
  }
}
