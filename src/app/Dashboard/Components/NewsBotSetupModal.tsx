"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signOut as signOutSecondary,
} from "firebase/auth";
import { getDatabase, ref, set, get, update } from "firebase/database";
import { X, Bot, Copy, TriangleAlert } from "lucide-react";
import { db } from "@/app/lib/firebase";
import { useServer } from "@/app/Context/ServerContext";
import { useChannel } from "@/app/Context/ChannelContext";
import { useToast } from "@/app/Context/ToastContext";

type Result = {
  email: string;
  password: string;
  uid: string;
  channelId: string;
  ecdhPrivateJwk: string;
  ecdsaPrivateJwk: string;
};

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function NewsBotSetupModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const { activeServerId } = useServer();
  const { channels, createChannel } = useChannel();
  const { showToast } = useToast();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => setMounted(true), []);
  if (!isOpen || !mounted) return null;

  async function handleSetup() {
    if (!activeServerId || running) return;
    setRunning(true);
    try {
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
      const ecdhPublicJwk = await crypto.subtle.exportKey("jwk", ecdhPair.publicKey);
      const ecdhPrivateJwk = await crypto.subtle.exportKey("jwk", ecdhPair.privateKey);
      const ecdsaPublicJwk = await crypto.subtle.exportKey("jwk", ecdsaPair.publicKey);
      const ecdsaPrivateJwk = await crypto.subtle.exportKey("jwk", ecdsaPair.privateKey);
      const keyVersion = crypto.randomUUID();

      // SEPARATE Firebase-App-Instanz nötig — sonst würde
      // createUserWithEmailAndPassword die eigene, aktive Admin-Sitzung im
      // Browser durch die neue Bot-Sitzung ersetzen.
      const email = `newsbot+${Date.now()}@cryptflow.internal`;
      const password = randomPassword();
      const secondaryApp = initializeApp(
        {
          apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
          authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
          databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL!,
          projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
        },
        `newsbot-setup-${Date.now()}`
      );
      const secondaryAuth = getAuth(secondaryApp);
      const secondaryDb = getDatabase(secondaryApp);
      let botUid: string;
      try {
        const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        botUid = cred.user.uid;

        await set(ref(secondaryDb, `newusers/${botUid}`), {
          authUid: botUid,
          newname: "News Bot",
          newemail: email,
          username: `newsbot_${botUid.slice(0, 6).toLowerCase()}`,
          avatar: "/avatar1.png",
          isGuest: false,
        });
        await set(ref(secondaryDb, `usernames/newsbot_${botUid.slice(0, 6).toLowerCase()}`), {
          uid: botUid,
          email,
        });
        await set(ref(secondaryDb, `publicKeys/${botUid}`), {
          ecdhPublicJwk,
          ecdsaPublicJwk,
          keyVersion,
        });
      } finally {
        await signOutSecondary(secondaryAuth).catch(() => {});
        await deleteApp(secondaryApp).catch(() => {});
      }

      // ensureUserInAllChannels (läuft automatisch bei jeder Änderung an
      // serverMembers) liefert dem Bot von selbst einen Channel-Key-Umschlag,
      // sobald er unten als Mitglied eingetragen ist.
      let channelId = channels.find((c) => c.name === "news" && c.serverId === activeServerId)
        ?.id;
      if (!channelId) {
        await createChannel("news", "Automatische Tech-News (News-Bot)", false, {
          announcementOnly: true,
        });
        const chansSnap = await get(ref(db, "channels"));
        const chans =
          (chansSnap.val() as Record<string, { name?: string; serverId?: string }> | null) ||
          {};
        channelId = Object.entries(chans).find(
          ([, c]) => c.name === "news" && c.serverId === activeServerId
        )?.[0];
      }
      if (!channelId) throw new Error("#news-Channel konnte nicht ermittelt werden.");

      await update(ref(db), {
        [`serverMembers/${activeServerId}/${botUid}`]: { role: "admin", joinedAt: Date.now() },
        [`userServers/${botUid}/${activeServerId}`]: true,
      });

      setResult({
        email,
        password,
        uid: botUid,
        channelId,
        ecdhPrivateJwk: JSON.stringify(ecdhPrivateJwk),
        ecdsaPrivateJwk: JSON.stringify(ecdsaPrivateJwk),
      });
      showToast("News-Bot eingerichtet.", "success");
    } catch (e) {
      console.error("[NewsBotSetupModal] Einrichtung fehlgeschlagen:", e);
      showToast(e instanceof Error ? e.message : "Einrichtung fehlgeschlagen.", "error");
    } finally {
      setRunning(false);
    }
  }

  function copyEnvBlock() {
    if (!result) return;
    const block = [
      `NEWSBOT_EMAIL=${result.email}`,
      `NEWSBOT_PASSWORD=${result.password}`,
      `NEWSBOT_UID=${result.uid}`,
      `NEWSBOT_CHANNEL_ID=${result.channelId}`,
      `NEWSBOT_ECDH_PRIVATE_JWK=${result.ecdhPrivateJwk}`,
      `NEWSBOT_ECDSA_PRIVATE_JWK=${result.ecdsaPrivateJwk}`,
    ].join("\n");
    navigator.clipboard
      .writeText(block)
      .then(() => showToast("In die Zwischenablage kopiert.", "success"))
      .catch(() => {});
  }

  return createPortal(
    <div
      className="modal-overlay z-[70]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="News-Bot einrichten"
    >
      <div className="modal-card w-full max-w-[560px] max-h-[85vh] overflow-y-auto p-6 sm:p-8">
        <button
          onClick={onClose}
          className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label="Modal schließen"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-2 mb-4">
          <Bot size={20} className="text-[var(--accent)] shrink-0" />
          <h2 className="text-xl font-semibold text-[var(--foreground)]">
            News-Bot einrichten
          </h2>
        </div>

        {!result ? (
          <>
            <p className="text-sm text-[var(--foreground-secondary)] mb-4">
              Legt einen eigenen, verschlüsselungsfähigen Bot-Account an, macht ihn zum
              Admin dieses Servers und erstellt (falls nötig) einen #news-Channel, in dem
              nur der Bot posten kann. Läuft einmalig — danach bekommst du Zugangsdaten
              zum Eintragen in die Server-Umgebungsvariablen.
            </p>
            <button
              onClick={handleSetup}
              disabled={running}
              className="btn-primary"
            >
              {running ? "Richtet ein…" : "Jetzt einrichten"}
            </button>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2 mb-4 p-3 rounded-xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] border border-[var(--danger)]">
              <TriangleAlert size={16} className="text-[var(--danger)] shrink-0 mt-0.5" />
              <p className="text-xs text-[var(--foreground)]">
                Diese Werte werden nur jetzt angezeigt. Trage sie als Umgebungsvariablen
                ein (lokal in <code>.env.local</code>, online in den Vercel-Projekt-
                einstellungen) — niemals ins Repository committen.
              </p>
            </div>
            <pre className="text-xs bg-[var(--surface-elevated)] border border-[var(--border-subtle)] rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-all mb-4">
{`NEWSBOT_EMAIL=${result.email}
NEWSBOT_PASSWORD=${result.password}
NEWSBOT_UID=${result.uid}
NEWSBOT_CHANNEL_ID=${result.channelId}
NEWSBOT_ECDH_PRIVATE_JWK=${result.ecdhPrivateJwk}
NEWSBOT_ECDSA_PRIVATE_JWK=${result.ecdsaPrivateJwk}`}
            </pre>
            <div className="flex justify-end gap-3">
              <button onClick={copyEnvBlock} className="btn-secondary">
                <Copy size={14} />
                Kopieren
              </button>
              <button onClick={onClose} className="btn-primary">
                Fertig
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
