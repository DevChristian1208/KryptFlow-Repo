"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ref, get, set, update, push } from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "@/app/Context/UserContext";
import { useDirect } from "@/app/Context/DirectContext";
import { useServer } from "@/app/Context/ServerContext";
import { useToast } from "@/app/Context/ToastContext";
import {
  X,
  MessageCircle,
  UserPlus,
  UserMinus,
  Ban,
  Check,
  Server as ServerIcon,
  Flag,
} from "lucide-react";
import AvatarLightbox from "./AvatarLightbox";
import ConfirmDialog from "./ConfirmDialog";
import { SOCIAL_PLATFORMS } from "./SettingsModal";

const REPORT_REASONS = [
  "Spam oder Werbung",
  "Belästigung oder Mobbing",
  "Unangemessene Inhalte",
  "Sonstiges",
] as const;

type NewUserDb = {
  newname?: string;
  newemail?: string;
  avatar?: string;
  status?: string;
  socialLinks?: Record<string, { platform?: string; label: string; url: string }>;
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
  const [mutualServers, setMutualServers] = useState<
    { id: string; name: string; iconUrl?: string }[]
  >([]);
  const [invitedServerIds, setInvitedServerIds] = useState<Set<string>>(new Set());
  const [statusDraft, setStatusDraft] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);
  const [showServerPicker, setShowServerPicker] = useState(false);
  const [avatarLightboxOpen, setAvatarLightboxOpen] = useState(false);
  const [removeFriendConfirmOpen, setRemoveFriendConfirmOpen] = useState(false);
  const [removingFriend, setRemovingFriend] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<string>(REPORT_REASONS[0]);
  const [reportDetails, setReportDetails] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [alreadyReported, setAlreadyReported] = useState(false);

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
    // Schutz vor Race: klickt man schnell hintereinander auf mehrere
    // Profile, darf eine spät auflösende ältere Anfrage nicht die Anzeige
    // des inzwischen geöffneten, neueren Profils überschreiben.
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const profileSnap = await get(ref(db, `newusers/${userId}`));
        if (cancelled) return;
        const p = (profileSnap.val() as NewUserDb | null) || null;
        setProfile(p);
        setStatusDraft(p?.status || "");

        if (!isSelf && me?.id) {
          const [mySnap, theirSnap, pendingSnap, myReportsSnap] = await Promise.all([
            get(ref(db, `friends/${me.id}`)),
            get(ref(db, `friends/${userId}`)),
            get(ref(db, `friendRequests/${userId}/${me.id}`)),
            // Eigener, isolierter Fehlerfang: das "Melden"-Feature ist rein
            // optional (Grund: neue Rule evtl. noch nicht importiert) — ein
            // Fehler hier darf niemals den gesamten Profil-Dialog blockieren.
            get(ref(db, `userReports/${me.id}`)).catch((e) => {
              console.warn("[UserProfileDialog] userReports nicht lesbar:", e);
              return null;
            }),
          ]);
          if (cancelled) return;
          const myFriends = (mySnap.val() as Record<string, FriendEntry> | null) || {};
          const theirFriends =
            (theirSnap.val() as Record<string, FriendEntry> | null) || {};

          setFriendSince(myFriends[userId]?.since ?? null);
          setPendingRequest(pendingSnap.exists());

          const myReports =
            (myReportsSnap?.val() as Record<string, { reportedUid?: string }> | null) || {};
          setAlreadyReported(
            Object.values(myReports).some((r) => r.reportedUid === userId)
          );

          const mutual = Object.keys(myFriends)
            .filter((uid) => uid !== userId && uid !== me.id && theirFriends[uid])
            .map((uid) => ({
              id: uid,
              name: myFriends[uid]?.name || "Unbekannt",
              avatar: myFriends[uid]?.avatar,
            }));
          setMutualFriends(mutual);

          // Gemeinsame Server: da userServers/{fremde-uid} für uns nicht
          // lesbar ist (Rule beschränkt auf auth.uid === $uid), stattdessen
          // pro eigenem Server prüfen, ob userId dort auch Mitglied ist —
          // serverMembers/{serverId} ist für alle Mitglieder dieses Servers
          // lesbar, unabhängig von deren jeweiliger uid.
          const memberChecks = await Promise.all(
            servers.map((s) =>
              get(ref(db, `serverMembers/${s.id}/${userId}`)).then((snap) => ({
                server: s,
                isMember: snap.exists(),
              }))
            )
          );
          if (cancelled) return;
          setMutualServers(
            memberChecks
              .filter((r) => r.isMember)
              .map((r) => ({ id: r.server.id, name: r.server.name, iconUrl: r.server.iconUrl }))
          );
        } else {
          setFriendSince(null);
          setMutualFriends([]);
          setMutualServers([]);
          setPendingRequest(false);
          setAlreadyReported(false);
        }
      } catch (e) {
        console.error("[UserProfileDialog] Laden fehlgeschlagen:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, userId, me?.id, isSelf, servers]);

  async function handleAddFriend() {
    if (!me?.id || friendSince) return;
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

  async function handleRemoveFriend() {
    if (!me?.id) return;
    setRemovingFriend(true);
    try {
      await update(ref(db), {
        [`friends/${me.id}/${userId}`]: null,
        [`friends/${userId}/${me.id}`]: null,
      });
      setFriendSince(null);
      setMutualFriends([]);
      setRemoveFriendConfirmOpen(false);
      showToast("Freund entfernt.", "success");
    } catch {
      showToast("Freund konnte nicht entfernt werden.", "error");
    } finally {
      setRemovingFriend(false);
    }
  }

  async function handleSubmitReport() {
    if (!me?.id) return;
    setReportSubmitting(true);
    try {
      const reportRef = push(ref(db, `userReports/${me.id}`));
      await set(reportRef, {
        reporterUid: me.id,
        reportedUid: userId,
        reportedName: profile?.newname || "Unbekannt",
        reason: reportReason,
        details: reportDetails.trim() || null,
        createdAt: Date.now(),
      });
      setAlreadyReported(true);
      setReportOpen(false);
      setReportDetails("");
      showToast("Danke, wir prüfen das.", "success");
    } catch {
      showToast("Meldung konnte nicht gesendet werden.", "error");
    } finally {
      setReportSubmitting(false);
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

  return (
    <>
      {createPortal(
        <div
          className="modal-overlay z-[70]"
          onClick={(e) => e.currentTarget === e.target && onClose()}
          role="dialog"
          aria-modal="true"
          aria-label="Profil"
        >
      <div className="modal-card w-full max-w-[420px] max-h-[85vh] overflow-y-auto p-6 sm:p-8">
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
              <button
                type="button"
                onClick={() => setAvatarLightboxOpen(true)}
                title="Profilbild vergrößern"
                className="hover:opacity-80 transition"
              >
                <Image
                  src={profile?.avatar || "/avatar1.png"}
                  alt={profile?.newname || "Profil"}
                  width={80}
                  height={80}
                  className="w-20 h-20 rounded-full object-cover mb-3"
                />
              </button>
              <AvatarLightbox
                open={avatarLightboxOpen}
                onClose={() => setAvatarLightboxOpen(false)}
                src={profile?.avatar || "/avatar1.png"}
                alt={profile?.newname || "Profil"}
                size={160}
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

            {profile?.socialLinks && Object.keys(profile.socialLinks).length > 0 && (
              <div className="flex flex-wrap justify-center gap-2 mb-6">
                {Object.values(profile.socialLinks).map((link) => {
                  const platform = SOCIAL_PLATFORMS.find((p) => p.id === link.platform);
                  const Icon = platform?.icon;
                  return (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] text-[var(--accent)] hover:opacity-80 transition"
                    >
                      {Icon && <Icon size={12} />}
                      {link.label}
                    </a>
                  );
                })}
              </div>
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
                  {friendSince && (
                    <button
                      onClick={() => setRemoveFriendConfirmOpen(true)}
                      className="btn-secondary text-sm"
                    >
                      <UserMinus size={14} />
                      Freund entfernen
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
                  <button
                    onClick={() => setReportOpen(true)}
                    disabled={alreadyReported}
                    className="btn-secondary text-sm text-[var(--danger)] border-[var(--danger)] disabled:opacity-50 disabled:text-[var(--foreground-secondary)] disabled:border-[var(--border-subtle)]"
                  >
                    <Flag size={14} />
                    {alreadyReported ? "Gemeldet" : "Melden"}
                  </button>
                </div>

                {mutualFriends.length > 0 && (
                  <div className="mb-6">
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
                            className="w-6 h-6 rounded-full object-cover"
                          />
                          <span className="text-sm text-[var(--foreground)]">{f.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {mutualServers.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-2">
                      Gemeinsame Server
                    </h3>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {mutualServers.map((s) => (
                        <div
                          key={s.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
                        >
                          {s.iconUrl ? (
                            <Image
                              src={s.iconUrl}
                              alt={s.name}
                              width={24}
                              height={24}
                              className="w-6 h-6 rounded-full object-cover"
                            />
                          ) : (
                            <div
                              className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0"
                              style={{ background: "linear-gradient(135deg, #0a84ff, #0058b8)" }}
                            >
                              {s.name.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                          <span className="text-sm text-[var(--foreground)]">{s.name}</span>
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
      )}

      <ConfirmDialog
        isOpen={removeFriendConfirmOpen}
        title="Freund entfernen"
        message={`Möchtest du ${profile?.newname || "diese Person"} wirklich aus deiner Freundesliste entfernen?`}
        confirmLabel="Entfernen"
        busy={removingFriend}
        onConfirm={handleRemoveFriend}
        onCancel={() => setRemoveFriendConfirmOpen(false)}
      />

      {reportOpen &&
        mounted &&
        createPortal(
          <div
            className="modal-overlay z-[80]"
            onClick={(e) => e.currentTarget === e.target && setReportOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label="Nutzer melden"
          >
            <div className="modal-card w-full max-w-[420px] p-6 sm:p-7">
              <button
                onClick={() => setReportOpen(false)}
                className="btn-icon absolute top-4 right-4 w-8 h-8 text-[var(--foreground-secondary)]"
                aria-label="Dialog schließen"
              >
                <X size={16} />
              </button>
              <div className="flex items-center gap-2 mb-2">
                <Flag size={20} className="text-[var(--danger)] shrink-0" />
                <h2 className="text-lg font-semibold text-[var(--foreground)]">
                  {profile?.newname || "Nutzer"} melden
                </h2>
              </div>
              <p className="text-sm text-[var(--foreground-secondary)] mb-4">
                Deine Meldung wird vertraulich geprüft. Ein Kontoausschluss erfolgt nicht automatisch.
              </p>

              <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
                Grund
              </label>
              <div className="space-y-1 mb-4">
                {REPORT_REASONS.map((r) => (
                  <label
                    key={r}
                    className="flex items-center gap-2 text-sm text-[var(--foreground)] cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="report-reason"
                      checked={reportReason === r}
                      onChange={() => setReportReason(r)}
                    />
                    {r}
                  </label>
                ))}
              </div>

              <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
                Details (optional)
              </label>
              <div className="input-pill mb-6">
                <textarea
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  placeholder="Weitere Informationen…"
                  maxLength={500}
                  rows={3}
                  className="w-full resize-none bg-transparent outline-none text-[var(--foreground)]"
                />
              </div>

              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setReportOpen(false)}
                  className="btn-secondary"
                  disabled={reportSubmitting}
                >
                  Abbrechen
                </button>
                <button
                  onClick={handleSubmitReport}
                  disabled={reportSubmitting}
                  className="btn-primary"
                  style={{ background: "var(--danger)" }}
                >
                  {reportSubmitting ? "…" : "Melden"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
