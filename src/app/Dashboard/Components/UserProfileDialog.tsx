"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ref, get, set, update } from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "@/app/Context/UserContext";
import { useDirect } from "@/app/Context/DirectContext";
import { useServer } from "@/app/Context/ServerContext";
import { useToast } from "@/app/Context/ToastContext";
import { X, MessageCircle, UserPlus, Ban, Check, Server as ServerIcon } from "lucide-react";

type NewUserDb = {
  newname?: string;
  newemail?: string;
  avatar?: string;
  status?: string;
};

type FriendEntry = { name?: string; avatar?: string; since?: number };

function formatDate(ts?: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function UserProfileDialog({
  userId,
  isOpen,
  onClose,
}: {
  userId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const { user: me } = useUser();
  const { startDMWith, isBlocked, blockUser, unblockUser } = useDirect();
  const { servers, inviteUserToServer } = useServer();
  const { showToast } = useToast();

  const [profile, setProfile] = useState<NewUserDb | null>(null);
  const [loading, setLoading] = useState(true);
  const [friendSince, setFriendSince] = useState<number | null>(null);
  const [mutualFriends, setMutualFriends] = useState<
    { id: string; name: string; avatar?: string }[]
  >([]);
  const [pendingRequest, setPendingRequest] = useState(false);
  const [invitedServerIds, setInvitedServerIds] = useState<Set<string>>(new Set());
  const [statusDraft, setStatusDraft] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);
  const [showServerPicker, setShowServerPicker] = useState(false);

  const isSelf = me?.id === userId;
  const blocked = !isSelf && isBlocked(userId);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !userId) return;
    setLoading(true);
    (async () => {
      try {
        const profileSnap = await get(ref(db, `newusers/${userId}`));
        const p = (profileSnap.val() as NewUserDb | null) || null;
        setProfile(p);
        setStatusDraft(p?.status || "");

        if (!isSelf && me?.id) {
          const [mySnap, theirSnap, pendingSnap] = await Promise.all([
            get(ref(db, `friends/${me.id}`)),
            get(ref(db, `friends/${userId}`)),
            get(ref(db, `friendRequests/${userId}/${me.id}`)),
          ]);
          const myFriends = (mySnap.val() as Record<string, FriendEntry> | null) || {};
          const theirFriends =
            (theirSnap.val() as Record<string, FriendEntry> | null) || {};

          setFriendSince(myFriends[userId]?.since ?? null);
          setPendingRequest(pendingSnap.exists());

          const mutual = Object.keys(myFriends)
            .filter((uid) => uid !== userId && uid !== me.id && theirFriends[uid])
            .map((uid) => ({
              id: uid,
              name: myFriends[uid]?.name || "Unbekannt",
              avatar: myFriends[uid]?.avatar,
            }));
          setMutualFriends(mutual);
        } else {
          setFriendSince(null);
          setMutualFriends([]);
          setPendingRequest(false);
        }
      } catch (e) {
        console.error("[UserProfileDialog] Laden fehlgeschlagen:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen, userId, me?.id, isSelf]);

  async function handleAddFriend() {
    if (!me?.id) return;
    try {
      await set(ref(db, `friendRequests/${userId}/${me.id}`), {
        fromName: me.name || "Unbekannt",
        fromAvatar: me.avatar || null,
        createdAt: Date.now(),
      });
      setPendingRequest(true);
      showToast("Freundschaftsanfrage gesendet.", "success");
    } catch {
      showToast("Anfrage konnte nicht gesendet werden.", "error");
    }
  }

  async function handleToggleBlock() {
    try {
      if (blocked) {
        await unblockUser(userId);
        showToast("Entblockt.", "success");
      } else {
        await blockUser(userId);
        showToast("Blockiert.", "success");
      }
    } catch {
      showToast("Aktion fehlgeschlagen.", "error");
    }
  }

  async function handleInviteToServer(serverId: string, serverName: string) {
    try {
      await inviteUserToServer(serverId, serverName, userId);
      setInvitedServerIds((prev) => new Set(prev).add(serverId));
      showToast(`Einladung zu ${serverName} gesendet.`, "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Fehler.", "error");
    }
  }

  async function handleSaveStatus() {
    if (!me?.id) return;
    setSavingStatus(true);
    try {
      await update(ref(db, `newusers/${me.id}`), { status: statusDraft.trim() });
      setProfile((prev) => (prev ? { ...prev, status: statusDraft.trim() } : prev));
      showToast("Status aktualisiert.", "success");
    } catch {
      showToast("Speichern fehlgeschlagen.", "error");
    } finally {
      setSavingStatus(false);
    }
  }

  function handleMessage() {
    startDMWith(userId);
    onClose();
  }

  if (!isOpen || !mounted) return null;

  const invitableServers = servers.filter(
    (s) => s.myRole === "owner" || s.myRole === "admin"
  );

  return createPortal(
    <div
      className="modal-overlay z-[70]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Profil"
    >
      <div className="modal-card w-full max-w-[420px] p-6 sm:p-8">
        <button
          onClick={onClose}
          className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label="Modal schließen"
        >
          <X size={18} />
        </button>

        {loading ? (
          <p className="text-sm text-[var(--foreground-secondary)] text-center py-10">
            Lädt…
          </p>
        ) : (
          <>
            <div className="flex flex-col items-center text-center mb-6">
              <Image
                src={profile?.avatar || "/avatar1.png"}
                alt={profile?.newname || "Profil"}
                width={80}
                height={80}
                className="rounded-full mb-3"
              />
              <h2 className="text-xl font-semibold text-[var(--foreground)]">
                {profile?.newname || "Unbekannt"}
              </h2>
              {profile?.newemail && (
                <p className="text-xs text-[var(--foreground-secondary)]">
                  {profile.newemail}
                </p>
              )}
              {friendSince && (
                <p className="text-xs text-[var(--foreground-secondary)] mt-1">
                  Befreundet seit {formatDate(friendSince)}
                </p>
              )}
            </div>

            {isSelf ? (
              <div className="mb-6">
                <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
                  Status
                </label>
                <div className="flex gap-2">
                  <div className="input-pill flex-1">
                    <input
                      value={statusDraft}
                      onChange={(e) => setStatusDraft(e.target.value)}
                      type="text"
                      placeholder="z. B. Im Urlaub, Verfügbar …"
                      maxLength={80}
                    />
                  </div>
                  <button
                    onClick={handleSaveStatus}
                    disabled={savingStatus}
                    className="btn-secondary shrink-0 px-3"
                  >
                    <Check size={16} />
                  </button>
                </div>
              </div>
            ) : (
              profile?.status && (
                <p className="text-sm text-center text-[var(--foreground)] italic mb-6 px-3 py-2 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-subtle)]">
                  „{profile.status}&rdquo;
                </p>
              )
            )}

            {!isSelf && (
              <>
                <div className="flex flex-wrap gap-2 mb-6">
                  <button onClick={handleMessage} className="btn-primary text-sm">
                    <MessageCircle size={14} />
                    Nachricht
                  </button>
                  {!friendSince && (
                    <button
                      onClick={handleAddFriend}
                      disabled={pendingRequest}
                      className="btn-secondary text-sm disabled:opacity-50"
                    >
                      <UserPlus size={14} />
                      {pendingRequest ? "Anfrage gesendet" : "Freund hinzufügen"}
                    </button>
                  )}
                  {invitableServers.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => setShowServerPicker((v) => !v)}
                        className="btn-secondary text-sm"
                      >
                        <ServerIcon size={14} />
                        Zu Server einladen
                      </button>
                      {showServerPicker && (
                        <div className="card-surface absolute left-0 top-10 z-50 w-56 p-2 space-y-1">
                          {invitableServers.map((s) => (
                            <button
                              key={s.id}
                              onClick={() => handleInviteToServer(s.id, s.name)}
                              disabled={invitedServerIds.has(s.id)}
                              className="w-full text-left text-sm px-2 py-1.5 rounded-lg hover:bg-[var(--border-subtle)] disabled:opacity-50 text-[var(--foreground)]"
                            >
                              {invitedServerIds.has(s.id) ? `${s.name} (eingeladen)` : s.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    onClick={handleToggleBlock}
                    className={`btn-secondary text-sm ${
                      blocked ? "" : "text-[var(--danger)] border-[var(--danger)]"
                    }`}
                  >
                    <Ban size={14} />
                    {blocked ? "Entblocken" : "Blockieren"}
                  </button>
                </div>

                {mutualFriends.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-2">
                      Gemeinsame Freunde
                    </h3>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {mutualFriends.map((f) => (
                        <div
                          key={f.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
                        >
                          <Image
                            src={f.avatar || "/avatar1.png"}
                            alt={f.name}
                            width={24}
                            height={24}
                            className="rounded-full"
                          />
                          <span className="text-sm text-[var(--foreground)]">{f.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
