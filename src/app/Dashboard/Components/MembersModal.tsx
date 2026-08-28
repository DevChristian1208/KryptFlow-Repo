"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ref, query as fbQuery, orderByChild, startAt, endAt, get } from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "@/app/Context/UserContext";
import { useChannel } from "@/app/Context/ChannelContext";
import { useDirect } from "@/app/Context/DirectContext";
import { useToast } from "@/app/Context/ToastContext";
import { Search, X, UserPlus } from "lucide-react";

type Member = {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
};

type InviteCandidate = { id: string; name: string; username: string; avatar?: string };
type NewUserDb = {
  authUid?: string;
  newname?: string;
  username?: string;
  avatar?: string;
};

export default function MembersModal({
  isOpen,
  onClose,
  channelId,
  members,
  channelName,
  onStartDM,
}: {
  isOpen: boolean;
  onClose: () => void;
  channelId: string;
  members: Member[];
  channelName: string;
  onStartDM: (userId: string) => void;
}) {
  const { user } = useUser();
  const { inviteToChannel } = useChannel();
  const { sendDirectSystemMessage } = useDirect();
  const { showToast } = useToast();
  const [query, setQuery] = useState("");
  const [inviteTerm, setInviteTerm] = useState("");
  const [inviteResults, setInviteResults] = useState<InviteCandidate[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);

  useEffect(() => {
    const cleaned = inviteTerm.trim().toLowerCase();
    if (!cleaned) {
      setInviteResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setInviteLoading(true);
      try {
        const q = fbQuery(
          ref(db, "newusers"),
          orderByChild("username"),
          startAt(cleaned),
          endAt(cleaned + "")
        );
        const snap = await get(q);
        const val = (snap.val() as Record<string, NewUserDb> | null) || {};
        const list: InviteCandidate[] = Object.values(val)
          .filter(
            (u) =>
              u.authUid &&
              u.authUid !== user?.id &&
              u.username &&
              !memberIds.has(u.authUid)
          )
          .map((u) => ({
            id: u.authUid!,
            name: u.newname || "Unbekannt",
            username: u.username!,
            avatar: u.avatar,
          }));
        setInviteResults(list);
      } catch (e) {
        console.error("[MembersModal] Einladungs-Suche fehlgeschlagen:", e);
      } finally {
        setInviteLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [inviteTerm, user?.id, memberIds]);

  const handleInvite = async (candidate: InviteCandidate) => {
    if (!user?.id) return;
    try {
      await inviteToChannel(channelId, channelName, candidate.id);
      setInvited((prev) => new Set(prev).add(candidate.id));
      showToast(`Einladung an ${candidate.name} gesendet.`, "success");
      // Zusätzlich zur Glocken-Benachrichtigung eine Karte im DM-Chat mit
      // dem Eingeladenen hinterlassen (auf Wunsch des Nutzers).
      sendDirectSystemMessage(candidate.id, "channelInvite", {
        channelId,
        channelName,
        byUid: user.id,
        byName: user.name || "Unbekannt",
      }).catch(() => {});
    } catch {
      showToast("Einladung konnte nicht gesendet werden.", "error");
    }
  };

  const filtered = useMemo(() => {
    //Wenn das Suchfeld geschlossen ist-> gibt leere Liste zurück
    if (!isOpen) return [];
    //User Eingabe(query) bereinigen
    const q = query.trim().toLowerCase();
    //Wenn kein Suchtext vorhanden ist -> Zeig alle Mitglieder
    if (!q) return members;
    //Filtere anhand von Name und Email
    return members.filter((m) => {
      const name = m.name?.toLowerCase() ?? "";
      const mail = m.email?.toLowerCase() ?? "";
      return name.includes(q) || mail.includes(q);
    });
  }, [isOpen, members, query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      aria-modal="true"
      role="dialog"
      aria-label="Mitgliederliste"
    >
      <div className="modal-card w-full max-w-md sm:max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="min-w-0">
            <h3 className="text-lg sm:text-xl font-semibold truncate text-[var(--foreground)]">
              Mitglieder
            </h3>
            <p className="text-xs text-[var(--foreground-secondary)] truncate">
              #{channelName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-icon w-9 h-9 text-[var(--foreground-secondary)]"
            aria-label="Schließen"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pt-3 pb-2">
          <div className="input-pill">
            <Search size={18} className="text-[var(--foreground-secondary)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Mitglieder suchen …"
              autoFocus
            />
          </div>
          <div className="mt-2 text-xs text-[var(--foreground-secondary)]">
            {filtered.length} Ergebnis{filtered.length === 1 ? "" : "se"}
          </div>
        </div>

        <div className="max-h-[60vh] sm:max-h-[65vh] overflow-y-auto px-3 sm:px-5 py-3 space-y-2">
          {filtered.map((m) => {
            const isSelf = user?.email && m.email && user.email === m.email;

            return (
              <div
                key={m.id}
                className="flex items-center justify-between gap-2 sm:gap-3 px-2 py-2 rounded-xl hover:bg-[var(--border-subtle)]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Image
                    src={m.avatar || "/avatar1.png"}
                    alt={m.name}
                    width={40}
                    height={40}
                    className="rounded-full"
                  />
                  <div className="min-w-0">
                    <div className="font-medium truncate text-[var(--foreground)]">
                      {m.name}{" "}
                      {isSelf && (
                        <span className="text-xs text-[var(--foreground-secondary)]">
                          (Du)
                        </span>
                      )}
                    </div>
                    {m.email && (
                      <div className="text-xs text-[var(--foreground-secondary)] truncate">
                        {m.email}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (!isSelf) onStartDM(m.id);
                  }}
                  disabled={Boolean(isSelf)}
                  aria-disabled={isSelf ? true : false}
                  className={
                    isSelf
                      ? "shrink-0 inline-flex items-center justify-center rounded-full px-3 py-1.5 text-sm font-medium bg-[var(--border-subtle)] text-[var(--foreground-secondary)] cursor-not-allowed"
                      : "btn-primary shrink-0 px-3 py-1.5 text-sm"
                  }
                >
                  Nachricht
                </button>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="text-center text-sm text-[var(--foreground-secondary)] py-6">
              Keine Ergebnisse für „{query}“.
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[var(--border-subtle)]">
          <h4 className="text-sm font-semibold text-[var(--foreground)] mb-2">
            Person einladen
          </h4>
          <div className="input-pill mb-2">
            <UserPlus size={16} className="text-[var(--foreground-secondary)]" />
            <input
              value={inviteTerm}
              onChange={(e) => setInviteTerm(e.target.value)}
              placeholder="Benutzername suchen …"
            />
          </div>
          {inviteLoading && (
            <p className="text-xs text-[var(--foreground-secondary)] px-1">Suche…</p>
          )}
          {!inviteLoading && inviteTerm.trim() && inviteResults.length === 0 && (
            <p className="text-xs text-[var(--foreground-secondary)] px-1">
              Keine Treffer.
            </p>
          )}
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {inviteResults.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 px-1 py-1.5 rounded-lg hover:bg-[var(--border-subtle)]"
              >
                <Image
                  src={c.avatar || "/avatar1.png"}
                  alt={c.name}
                  width={26}
                  height={26}
                  className="rounded-full shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--foreground)]">{c.name}</div>
                  <div className="truncate text-xs text-[var(--foreground-secondary)]">
                    @{c.username}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleInvite(c)}
                  disabled={invited.has(c.id)}
                  className="btn-secondary shrink-0 px-2 py-1 text-xs disabled:opacity-50"
                >
                  {invited.has(c.id) ? "Eingeladen" : "Einladen"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-[var(--border-subtle)] flex justify-end">
          <button type="button" onClick={onClose} className="btn-secondary">
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
