"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ref, get, update } from "firebase/database";
import {
  deleteUser,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "firebase/auth";
import { db, auth } from "@/app/lib/firebase";
import { X, TriangleAlert } from "lucide-react";
import { useToast } from "@/app/Context/ToastContext";
import { useUser } from "@/app/Context/UserContext";

export default function DeleteAccountModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const { showToast } = useToast();
  const { user } = useUser();
  const router = useRouter();

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (isOpen) setPassword("");
  }, [isOpen]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  async function handleDelete() {
    if (!user?.id || deleting) return;
    setDeleting(true);
    try {
      // Reauth zuerst (nur für Nutzer mit Passwort — Gäste sind ohnehin
      // gerade erst anonym angemeldet worden): stellt sicher, dass der
      // spätere deleteUser()-Aufruf nicht mit auth/requires-recent-login
      // scheitert. Ohne das müsste man zwischen zwei schlechten
      // Reihenfolgen wählen — DB-Wipe zuerst (Daten weg, Auth-Konto bleibt,
      // falls deleteUser scheitert) oder deleteUser zuerst (danach ist man
      // ausgeloggt und der DB-Wipe scheitert an den auth!=null-Regeln).
      const current = auth.currentUser;
      if (current && !user.isGuest && current.email) {
        if (!password.trim()) {
          showToast("Bitte dein Passwort zur Bestätigung eingeben.", "error");
          setDeleting(false);
          return;
        }
        await reauthenticateWithCredential(
          current,
          EmailAuthProvider.credential(current.email, password)
        );
      }

      const uid = user.id;

      const userServersSnap = await get(ref(db, `userServers/${uid}`));
      const serverIds = Object.keys(
        (userServersSnap.val() as Record<string, true> | null) || {}
      );

      // Owner können ihr Konto nicht einfach löschen, ohne den Server
      // dauerhaft "verwaist" zurückzulassen (niemand könnte ihn danach noch
      // löschen oder verwalten, da alle Owner-Aktionen exakt diese Rolle
      // voraussetzen). Statt das stillschweigend zu tun, hier hart blocken.
      const ownedServerIds: string[] = [];
      for (const sid of serverIds) {
        const memberSnap = await get(ref(db, `serverMembers/${sid}/${uid}`));
        if ((memberSnap.val() as { role?: string } | null)?.role === "owner") {
          ownedServerIds.push(sid);
        }
      }
      if (ownedServerIds.length > 0) {
        showToast(
          "Du bist Owner von mindestens einem Server. Bitte lösche diesen zuerst oder übertrage die Owner-Rolle, bevor du dein Konto löschst.",
          "error"
        );
        setDeleting(false);
        return;
      }

      const [chansSnap, newuserSnap, dmThreadsSnap] = await Promise.all([
        get(ref(db, "channels")),
        get(ref(db, `newusers/${uid}`)),
        get(ref(db, `dmThreads/${uid}`)),
      ]);
      const allChans =
        (chansSnap.val() as Record<string, { serverId?: string }> | null) || {};
      const myChannelIds = Object.entries(allChans)
        .filter(([, c]) => c.serverId && serverIds.includes(c.serverId))
        .map(([id]) => id);
      const username = (newuserSnap.val() as { username?: string } | null)?.username;
      const dmOtherUids = Object.keys(
        (dmThreadsSnap.val() as Record<string, unknown> | null) || {}
      );

      // Erst die Blätter (Channel-Mitgliedschaft/-Schlüssel), die noch eine
      // bestehende serverMembers-Zugehörigkeit voraussetzen, dann erst
      // serverMembers selbst entfernen (Cross-Path-Problem, wie an anderer
      // Stelle in dieser App bereits mehrfach aufgetreten).
      const leafUpdates: Record<string, null> = {};
      for (const cid of myChannelIds) {
        leafUpdates[`channelKeys/${cid}/${uid}`] = null;
        leafUpdates[`channels/${cid}/members/${uid}`] = null;
      }
      if (Object.keys(leafUpdates).length > 0) {
        await update(ref(db), leafUpdates);
      }

      // dmThreads/{uid} und userServers/{uid} haben keine Schreibregel für
      // den ganzen Knoten, nur für die einzelnen Unterpfade — deshalb hier
      // jedes Kind einzeln adressieren statt den Elternknoten zu löschen.
      const updates: Record<string, null> = {
        [`newusers/${uid}`]: null,
        [`publicKeys/${uid}`]: null,
        [`presence/${uid}`]: null,
      };
      for (const otherUid of dmOtherUids) {
        updates[`dmThreads/${uid}/${otherUid}`] = null;
      }
      for (const sid of serverIds) {
        updates[`userServers/${uid}/${sid}`] = null;
      }
      if (username) {
        updates[`usernames/${username}`] = null;
      }
      await update(ref(db), updates);

      const serverMemberUpdates: Record<string, null> = {};
      for (const sid of serverIds) {
        serverMemberUpdates[`serverMembers/${sid}/${uid}`] = null;
      }
      if (Object.keys(serverMemberUpdates).length > 0) {
        await update(ref(db), serverMemberUpdates);
      }

      if (current) await deleteUser(current);

      onClose();
      router.push("/Login");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
        showToast("Falsches Passwort.", "error");
      } else if (code === "auth/requires-recent-login") {
        showToast(
          "Aus Sicherheitsgründen musst du dich zuerst aus- und wieder einloggen, bevor du dein Konto endgültig löschen kannst.",
          "error"
        );
      } else {
        console.error("[DeleteAccountModal] Löschen fehlgeschlagen:", e);
        showToast("Konto konnte nicht gelöscht werden. Bitte erneut versuchen.", "error");
      }
    } finally {
      setDeleting(false);
    }
  }

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Konto löschen"
    >
      <div className="modal-card w-full max-w-[520px] max-h-[85vh] overflow-y-auto p-6 sm:p-8">
        <button
          onClick={onClose}
          className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label="Modal schließen"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-2 mb-2">
          <TriangleAlert size={22} className="text-[var(--danger)]" />
          <h2 className="text-xl sm:text-2xl font-semibold text-[var(--foreground)]">
            Konto löschen
          </h2>
        </div>
        <p className="text-sm text-[var(--foreground-secondary)] mb-6">
          Dein Profil, deine Verschlüsselungs-Schlüssel und deine Channel-Mitgliedschaften
          werden dauerhaft entfernt. Bereits gesendete Nachrichten bleiben für andere
          Mitglieder sichtbar. Diese Aktion kann nicht rückgängig gemacht werden.
        </p>

        {!user?.isGuest && (
          <div className="mb-6">
            <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
              Passwort zur Bestätigung
            </label>
            <div className="input-pill">
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder="Dein Passwort"
                autoComplete="current-password"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary">
            Abbrechen
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="btn-primary"
            style={{ background: "var(--danger)" }}
          >
            {deleting ? "Wird gelöscht…" : "Endgültig löschen"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
