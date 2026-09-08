"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import {
  ref,
  onValue,
  off,
  get,
  query as fbQuery,
  orderByChild,
  startAt,
  endAt,
} from "firebase/database";
import { db } from "@/app/lib/firebase";
import { uploadImage, ImageValidationError } from "@/app/lib/uploadImage";
import ConfirmDialog from "./ConfirmDialog";
import { useUser } from "@/app/Context/UserContext";
import { useServer, type Server, type ServerRole } from "@/app/Context/ServerContext";
import { useChannel } from "@/app/Context/ChannelContext";
import { useDirect } from "@/app/Context/DirectContext";
import { useToast } from "@/app/Context/ToastContext";
import {
  X,
  TriangleAlert,
  Copy,
  Settings as SettingsIcon,
  Users,
  Link as LinkIcon,
  Hash,
  UserPlus,
  Upload,
  LogOut,
  Trash2,
  SmilePlus,
  Tag,
  Plus,
  Bot,
} from "lucide-react";
import NewsBotSetupModal from "./NewsBotSetupModal";

type Tab = "overview" | "members" | "invites" | "channels" | "emojis" | "roles";

type MemberRow = {
  uid: string;
  role: ServerRole;
  name: string;
  avatar?: string;
  tagRoleIds: string[];
};

type NewUserDb = { authUid?: string; newname?: string; username?: string; avatar?: string };
type InviteCandidate = { id: string; name: string; username: string; avatar?: string };
type InviteDb = {
  serverId: string;
  createdByUid: string;
  createdAt: number;
  expiresAt?: number;
  maxUses?: number;
  useCount?: number;
};

export default function ServerSettingsModal({
  isOpen,
  onClose,
  server,
}: {
  isOpen: boolean;
  onClose: () => void;
  server: Server;
}) {
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const { showToast } = useToast();
  const { user } = useUser();
  const {
    renameServer,
    updateServerIcon,
    updateServerBanner,
    deleteServer,
    leaveServer,
    updateMemberRole,
    removeMember,
    banMember,
    unbanMember,
    createInvite,
    inviteUserToServer,
    setActiveServerId,
    customEmojis,
    addServerEmoji,
    removeServerEmoji,
    serverRoles,
    createServerRole,
    deleteServerRole,
    setMemberTagRoles,
  } = useServer();
  const { channels, setChannelRestricted, setChannelAnnouncementOnly, deleteChannel } = useChannel();
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);
  const [tagPopoverUid, setTagPopoverUid] = useState<string | null>(null);
  const [newsBotSetupOpen, setNewsBotSetupOpen] = useState(false);
  const [postingNews, setPostingNews] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleColor, setNewRoleColor] = useState("#0a84ff");
  const [creatingRole, setCreatingRole] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const { sendDirectSystemMessage } = useDirect();

  const [name, setName] = useState(server.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);
  const emojiInputRef = useRef<HTMLInputElement | null>(null);
  const [newEmojiName, setNewEmojiName] = useState("");
  const [uploadingEmoji, setUploadingEmoji] = useState(false);
  const [removingEmojiId, setRemovingEmojiId] = useState<string | null>(null);

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [bannedUsers, setBannedUsers] = useState<{ uid: string; name: string }[]>([]);
  const [invites, setInvites] = useState<(InviteDb & { code: string })[]>([]);
  const [creatingInvite, setCreatingInvite] = useState(false);

  const [inviteTerm, setInviteTerm] = useState("");
  const [inviteResults, setInviteResults] = useState<InviteCandidate[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [invitedUids, setInvitedUids] = useState<Set<string>>(new Set());

  const isOwner = server.myRole === "owner";
  const isAdmin = isOwner || server.myRole === "admin";

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (isOpen) {
      setTab("overview");
      setName(server.name);
    }
  }, [isOpen, server.name]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Mitglieder live laden + Profile auflösen
  useEffect(() => {
    if (!isOpen) return;
    const r = ref(db, `serverMembers/${server.id}`);
    const unsub = onValue(r, (snap) => {
      const raw =
        (snap.val() as Record<
          string,
          { role?: ServerRole; tagRoleIds?: Record<string, true> }
        > | null) || {};
      (async () => {
        const rows = await Promise.all(
          Object.entries(raw).map(async ([uid, v]) => {
            const tagRoleIds = Object.keys(v.tagRoleIds || {});
            if (user && uid === user.id) {
              return {
                uid,
                role: v.role || "member",
                name: user.name,
                avatar: user.avatar,
                tagRoleIds,
              };
            }
            const uSnap = await get(ref(db, `newusers/${uid}`));
            const u = uSnap.val() as NewUserDb | null;
            return {
              uid,
              role: v.role || "member",
              name: u?.newname || "Unbekannt",
              avatar: u?.avatar,
              tagRoleIds,
            };
          })
        );
        rows.sort((a, b) => {
          const order = { owner: 0, admin: 1, member: 2 };
          return order[a.role] - order[b.role] || a.name.localeCompare(b.name);
        });
        setMembers(rows);
      })();
    });
    return () => off(r, "value", unsub);
  }, [isOpen, server.id, user]);

  // Gebannte Nutzer live laden — nur relevant/lesbar für Owner/Admin.
  useEffect(() => {
    if (!isOpen || !isAdmin) {
      setBannedUsers([]);
      return;
    }
    const r = ref(db, `serverBans/${server.id}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, unknown> | null) || {};
      (async () => {
        const rows = await Promise.all(
          Object.keys(raw).map(async (uid) => {
            const uSnap = await get(ref(db, `newusers/${uid}`));
            const u = uSnap.val() as NewUserDb | null;
            return { uid, name: u?.newname || "Unbekannt" };
          })
        );
        rows.sort((a, b) => a.name.localeCompare(b.name));
        setBannedUsers(rows);
      })();
    });
    return () => off(r, "value", unsub);
  }, [isOpen, isAdmin, server.id]);

  // Person zum Server einladen: Suche nach Benutzername, ausgenommen bereits
  // vorhandene Mitglieder.
  useEffect(() => {
    const cleaned = inviteTerm.trim().toLowerCase();
    if (!cleaned) {
      setInviteResults([]);
      return;
    }
    const memberUids = new Set(members.map((m) => m.uid));
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
              !memberUids.has(u.authUid)
          )
          .map((u) => ({
            id: u.authUid!,
            name: u.newname || "Unbekannt",
            username: u.username!,
            avatar: u.avatar,
          }));
        setInviteResults(list);
      } catch (e) {
        console.error("[ServerSettingsModal] Einladungs-Suche fehlgeschlagen:", e);
      } finally {
        setInviteLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [inviteTerm, user?.id, members]);

  const handleInviteToServer = async (candidate: InviteCandidate) => {
    try {
      await inviteUserToServer(server.id, server.name, candidate.id);
      setInvitedUids((prev) => new Set(prev).add(candidate.id));
      showToast(`Einladung an ${candidate.name} gesendet.`, "success");
      if (user?.id) {
        sendDirectSystemMessage(candidate.id, "serverInvite", {
          serverId: server.id,
          serverName: server.name,
          byUid: user.id,
          byName: user.name || "Unbekannt",
        }).catch(() => {});
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Fehler.", "error");
    }
  };

  // Einladungen live laden (nur die dieses Servers)
  useEffect(() => {
    if (!isOpen || tab !== "invites") return;
    const r = ref(db, "serverInvites");
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, InviteDb> | null) || {};
      const list = Object.entries(raw)
        .filter(([, v]) => v.serverId === server.id)
        .map(([code, v]) => ({ code, ...v }))
        .sort((a, b) => b.createdAt - a.createdAt);
      setInvites(list);
    });
    return () => off(r, "value", unsub);
  }, [isOpen, tab, server.id]);

  async function handleRename() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await renameServer(server.id, name);
      showToast("Server umbenannt.", "success");
    } catch {
      showToast("Umbenennen fehlgeschlagen.", "error");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    if (deleting) return;
    setConfirmState({
      title: "Server löschen",
      message: `„${server.name}" wirklich endgültig löschen? Alle Channels und Nachrichten gehen dabei unwiderruflich verloren.`,
      confirmLabel: "Löschen",
      onConfirm: handleDelete,
    });
  }

  async function handleDelete() {
    setConfirmState(null);
    setDeleting(true);
    try {
      await deleteServer(server.id);
      setActiveServerId(null);
      onClose();
    } catch {
      showToast("Löschen fehlgeschlagen.", "error");
    } finally {
      setDeleting(false);
    }
  }

  function confirmLeave() {
    if (leaving) return;
    setConfirmState({
      title: "Server verlassen",
      message: `„${server.name}" wirklich verlassen?`,
      confirmLabel: "Verlassen",
      onConfirm: handleLeave,
    });
  }

  async function handleLeave() {
    setConfirmState(null);
    setLeaving(true);
    try {
      await leaveServer(server.id);
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Verlassen fehlgeschlagen.", "error");
    } finally {
      setLeaving(false);
    }
  }

  async function handleIconSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user?.id || uploadingIcon) return;
    setUploadingIcon(true);
    try {
      const url = await uploadImage(file, `serverIcons/${user.id}_${Date.now()}`);
      await updateServerIcon(server.id, url);
      showToast("Server-Icon aktualisiert.", "success");
    } catch (err) {
      showToast(
        err instanceof ImageValidationError ? err.message : "Icon-Upload fehlgeschlagen.",
        "error"
      );
    } finally {
      setUploadingIcon(false);
    }
  }

  async function handleBannerSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user?.id || uploadingBanner) return;
    setUploadingBanner(true);
    try {
      const url = await uploadImage(file, `serverBanners/${user.id}_${Date.now()}`);
      await updateServerBanner(server.id, url);
      showToast("Server-Banner aktualisiert.", "success");
    } catch (err) {
      showToast(
        err instanceof ImageValidationError ? err.message : "Banner-Upload fehlgeschlagen.",
        "error"
      );
    } finally {
      setUploadingBanner(false);
    }
  }

  async function handleEmojiSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const name = newEmojiName.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!file || !user?.id || uploadingEmoji) return;
    if (!name) {
      showToast("Bitte zuerst einen Namen (nur a-z, 0-9, _) eingeben.", "error");
      return;
    }
    setUploadingEmoji(true);
    try {
      const url = await uploadImage(file, `serverEmojis/${user.id}_${Date.now()}`);
      await addServerEmoji(name, url);
      setNewEmojiName("");
      showToast("Emoji hinzugefügt.", "success");
    } catch (err) {
      showToast(
        err instanceof ImageValidationError ? err.message : "Emoji-Upload fehlgeschlagen.",
        "error"
      );
    } finally {
      setUploadingEmoji(false);
    }
  }

  async function handleCreateInvite() {
    if (creatingInvite) return;
    setCreatingInvite(true);
    try {
      const code = await createInvite(server.id, {
        expiresInMs: 7 * 24 * 60 * 60 * 1000,
      });
      const link = `${window.location.origin}/invite/${code}`;
      try {
        await navigator.clipboard.writeText(link);
        showToast("Einladungslink erstellt und kopiert.", "success");
      } catch {
        showToast(`Einladungslink erstellt: ${link}`, "success");
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Fehler.", "error");
    } finally {
      setCreatingInvite(false);
    }
  }

  async function copyInvite(code: string) {
    const link = `${window.location.origin}/invite/${code}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast("Kopiert.", "success");
    } catch {
      showToast(link, "info");
    }
  }

  if (!isOpen || !mounted) return null;

  const TABS: { id: Tab; label: string; icon: typeof SettingsIcon }[] = [
    { id: "overview", label: "Übersicht", icon: SettingsIcon },
    { id: "members", label: "Mitglieder", icon: Users },
    { id: "invites", label: "Einladungen", icon: LinkIcon },
    { id: "channels", label: "Kanäle", icon: Hash },
    { id: "emojis", label: "Emojis", icon: SmilePlus },
    { id: "roles", label: "Rollen", icon: Tag },
  ];

  return createPortal(
    <>
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Server-Einstellungen"
    >
      <div className="modal-card w-full max-w-[640px] max-h-[85vh] overflow-y-auto p-6 sm:p-8">
        <button
          onClick={onClose}
          className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label="Modal schließen"
        >
          <X size={18} />
        </button>

        <h2 className="text-xl sm:text-2xl font-semibold mb-6 text-[var(--foreground)]">
          {server.name}
        </h2>

        <div className="flex gap-1 mb-6 border-b border-[var(--border-subtle)] overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition ${
                tab === t.id
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
              }`}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <div>
            {isAdmin && (
              <>
                <input
                  ref={bannerInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleBannerSelected}
                />
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleIconSelected}
                />
              </>
            )}

            <div
              className="relative w-full h-28 sm:h-36 rounded-xl mb-4 bg-[var(--surface-elevated)] border border-[var(--border-subtle)] overflow-hidden bg-cover bg-center flex items-end justify-end p-2"
              style={
                server.bannerUrl ? { backgroundImage: `url(${server.bannerUrl})` } : undefined
              }
            >
              {isAdmin && (
                <button
                  onClick={() => bannerInputRef.current?.click()}
                  disabled={uploadingBanner}
                  className="btn-secondary text-xs px-2.5 py-1.5"
                >
                  <Upload size={13} />
                  {uploadingBanner ? "Lädt hoch…" : "Banner hochladen"}
                </button>
              )}
            </div>

            <div className="flex items-center gap-3 mb-6">
              <div className="relative w-16 h-16 rounded-full overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shrink-0">
                {server.iconUrl ? (
                  <Image src={server.iconUrl} alt={server.name} fill className="object-cover" />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-white text-lg font-semibold"
                    style={{ background: "linear-gradient(135deg, #0a84ff, #0058b8)" }}
                  >
                    {server.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
              {isAdmin && (
                <button
                  onClick={() => iconInputRef.current?.click()}
                  disabled={uploadingIcon}
                  className="btn-secondary text-xs"
                >
                  <Upload size={13} />
                  {uploadingIcon ? "Lädt hoch…" : "Icon ändern"}
                </button>
              )}
            </div>

            <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
              Server-Name
            </label>
            <div className="flex gap-2 mb-6">
              <div className="input-pill flex-1">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  type="text"
                  disabled={!isAdmin}
                />
              </div>
              {isAdmin && (
                <button
                  onClick={handleRename}
                  disabled={saving || !name.trim()}
                  className="btn-secondary shrink-0"
                >
                  {saving ? "Speichert…" : "Speichern"}
                </button>
              )}
            </div>

            {isAdmin && (
              <div className="pt-6 border-t border-[var(--border-subtle)] mb-2">
                <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Bot size={14} /> News-Bot
                </h3>
                <p className="text-sm text-[var(--foreground-secondary)] mb-3">
                  Postet automatisch einen Tech-News-Digest (Hacker News) in den
                  #news-Channel, damit neue Server nicht komplett leer wirken.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setNewsBotSetupOpen(true)}
                    className="btn-secondary text-sm"
                  >
                    <Bot size={14} />
                    Bot einrichten
                  </button>
                  <button
                    onClick={async () => {
                      setPostingNews(true);
                      try {
                        const res = await fetch("/api/newsbot/post", { method: "POST" });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || "Fehlgeschlagen.");
                        showToast("News gepostet.", "success");
                      } catch (e) {
                        showToast(
                          e instanceof Error ? e.message : "Posten fehlgeschlagen.",
                          "error"
                        );
                      } finally {
                        setPostingNews(false);
                      }
                    }}
                    disabled={postingNews}
                    className="btn-secondary text-sm"
                  >
                    {postingNews ? "Postet…" : "Jetzt News posten"}
                  </button>
                </div>
              </div>
            )}

            {isOwner ? (
              <div className="pt-6 border-t border-[var(--border-subtle)]">
                <h3 className="text-sm font-semibold text-[var(--danger)] uppercase tracking-wide mb-3 flex items-center gap-2">
                  <TriangleAlert size={14} /> Danger Zone
                </h3>
                <p className="text-sm text-[var(--foreground-secondary)] mb-3">
                  Löscht den Server, alle seine Kanäle und Nachrichten dauerhaft.
                </p>
                <button
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="btn-secondary text-[var(--danger)] border-[var(--danger)]"
                >
                  <Trash2 size={14} />
                  {deleting ? "Wird gelöscht…" : "Server löschen"}
                </button>
              </div>
            ) : (
              <div className="pt-6 border-t border-[var(--border-subtle)]">
                <button
                  onClick={confirmLeave}
                  disabled={leaving}
                  className="btn-secondary text-[var(--danger)] border-[var(--danger)]"
                >
                  <LogOut size={14} />
                  {leaving ? "Verlässt…" : "Server verlassen"}
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "members" && (
          <div>
            {isAdmin && (
              <div className="mb-4 pb-4 border-b border-[var(--border-subtle)]">
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
                        className="w-[26px] h-[26px] rounded-full object-cover shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-[var(--foreground)]">
                          {c.name}
                        </div>
                        <div className="truncate text-xs text-[var(--foreground-secondary)]">
                          @{c.username}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleInviteToServer(c)}
                        disabled={invitedUids.has(c.id)}
                        className="btn-secondary shrink-0 px-2 py-1 text-xs disabled:opacity-50"
                      >
                        {invitedUids.has(c.id) ? "Eingeladen" : "Einladen"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="max-h-[50vh] overflow-y-auto space-y-2">
            {members.map((m) => {
              const isSelf = user?.id === m.uid;
              return (
                <div
                  key={m.uid}
                  className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-[var(--border-subtle)]"
                >
                  <Image
                    src={m.avatar || "/avatar1.png"}
                    alt={m.name}
                    width={36}
                    height={36}
                    className="w-9 h-9 rounded-full object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate text-[var(--foreground)] flex items-center gap-1.5 flex-wrap">
                      {m.name} {isSelf && <span className="text-xs text-[var(--foreground-secondary)]">(Du)</span>}
                      {m.tagRoleIds.map((rid) => {
                        const role = serverRoles.find((r) => r.id === rid);
                        if (!role) return null;
                        return (
                          <span
                            key={rid}
                            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                            style={{
                              backgroundColor: `${role.color}22`,
                              color: role.color,
                            }}
                          >
                            {role.name}
                          </span>
                        );
                      })}
                    </div>
                    <div className="text-xs text-[var(--foreground-secondary)] capitalize">
                      {m.role}
                    </div>
                  </div>
                  {isAdmin && serverRoles.length > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() =>
                          setTagPopoverUid((prev) => (prev === m.uid ? null : m.uid))
                        }
                        className="btn-icon w-7 h-7 shrink-0 text-[var(--foreground-secondary)]"
                        aria-label="Rollen-Tags zuweisen"
                        title="Rollen-Tags zuweisen"
                      >
                        <Tag size={14} />
                      </button>
                      {tagPopoverUid === m.uid && (
                        <div className="card-surface absolute right-0 top-9 z-50 w-48 p-2 space-y-1">
                          {serverRoles.map((role) => {
                            const checked = m.tagRoleIds.includes(role.id);
                            return (
                              <label
                                key={role.id}
                                className="flex items-center gap-2 text-xs px-1.5 py-1 rounded-lg hover:bg-[var(--border-subtle)] cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    const next = checked
                                      ? m.tagRoleIds.filter((id) => id !== role.id)
                                      : [...m.tagRoleIds, role.id];
                                    setMemberTagRoles(m.uid, next);
                                  }}
                                />
                                <span
                                  className="w-2.5 h-2.5 rounded-full shrink-0"
                                  style={{ backgroundColor: role.color }}
                                />
                                <span className="text-[var(--foreground)] truncate">
                                  {role.name}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {isOwner && !isSelf && m.role !== "owner" && (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        updateMemberRole(server.id, m.uid, e.target.value as ServerRole)
                      }
                      className="text-sm bg-transparent border border-[var(--border-subtle)] rounded-full px-2 py-1"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  )}
                  {isAdmin && !isSelf && m.role !== "owner" && (
                    <>
                      <button
                        onClick={() => removeMember(server.id, m.uid)}
                        className="btn-secondary text-xs px-3 py-1.5"
                      >
                        Kicken
                      </button>
                      <button
                        onClick={() =>
                          setConfirmState({
                            title: "Mitglied bannen",
                            message: `${m.name} wird entfernt und kann diesem Server nicht mehr per Einladungslink beitreten, bis der Bann aufgehoben wird.`,
                            confirmLabel: "Bannen",
                            onConfirm: async () => {
                              await banMember(server.id, m.uid);
                              setConfirmState(null);
                            },
                          })
                        }
                        className="btn-secondary text-[var(--danger)] border-[var(--danger)] text-xs px-3 py-1.5"
                      >
                        Bannen
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            </div>

            {isAdmin && bannedUsers.length > 0 && (
              <div className="mt-6 pt-4 border-t border-[var(--border-subtle)]">
                <h4 className="text-xs font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-2">
                  Gebannte Nutzer
                </h4>
                <div className="space-y-2">
                  {bannedUsers.map((b) => (
                    <div
                      key={b.uid}
                      className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-subtle)]"
                    >
                      <span className="text-sm text-[var(--foreground)] flex-1 truncate">
                        {b.name}
                      </span>
                      <button
                        onClick={() => unbanMember(server.id, b.uid)}
                        className="btn-secondary text-xs px-3 py-1.5"
                      >
                        Entbannen
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "invites" && (
          <div>
            {isAdmin && (
              <button
                onClick={handleCreateInvite}
                disabled={creatingInvite}
                className="btn-primary text-sm mb-4"
              >
                {creatingInvite ? "Erstellt…" : "Neuen Einladungslink erstellen"}
              </button>
            )}
            <p className="text-xs text-[var(--foreground-secondary)] mb-3">
              Links laufen standardmäßig nach 7 Tagen ab.
            </p>
            <div className="max-h-[40vh] overflow-y-auto space-y-2">
              {invites.map((inv) => (
                <div
                  key={inv.code}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-subtle)]"
                >
                  <div className="min-w-0 flex-1 text-sm text-[var(--foreground)] truncate font-mono">
                    {inv.code}
                  </div>
                  <div className="text-xs text-[var(--foreground-secondary)] shrink-0">
                    {inv.useCount || 0} genutzt
                  </div>
                  <button
                    onClick={() => copyInvite(inv.code)}
                    className="btn-icon w-7 h-7 shrink-0"
                    aria-label="Kopieren"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              ))}
              {invites.length === 0 && (
                <p className="text-sm text-[var(--foreground-secondary)] text-center py-4">
                  Noch keine Einladungslinks.
                </p>
              )}
            </div>
          </div>
        )}

        {tab === "channels" && (
          <div className="max-h-[50vh] overflow-y-auto space-y-2">
            {channels.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-subtle)]"
              >
                <span className="text-sm text-[var(--foreground)] truncate">#{c.name}</span>
                {isAdmin ? (
                  <div className="flex items-center gap-3 shrink-0">
                    <label
                      className="flex items-center gap-2 text-xs text-[var(--foreground-secondary)] cursor-pointer"
                      title="Nur explizit eingeladene Mitglieder können diesen Channel überhaupt sehen"
                    >
                      <input
                        type="checkbox"
                        checked={!!c.restricted}
                        onChange={(e) => setChannelRestricted(c.id, e.target.checked)}
                        className="accent-[var(--accent)]"
                      />
                      Eingeschränkt
                    </label>
                    <label
                      className="flex items-center gap-2 text-xs text-[var(--foreground-secondary)] cursor-pointer"
                      title="Alle mit Zugriff können lesen, aber nur Owner/Admin dürfen schreiben"
                    >
                      <input
                        type="checkbox"
                        checked={!!c.announcementOnly}
                        onChange={(e) => setChannelAnnouncementOnly(c.id, e.target.checked)}
                        className="accent-[var(--accent)]"
                      />
                      Nur Admins schreiben
                    </label>
                    <button
                      type="button"
                      aria-label={`#${c.name} löschen`}
                      disabled={deletingChannelId === c.id}
                      onClick={() =>
                        setConfirmState({
                          title: "Channel löschen",
                          message: `#${c.name} wirklich löschen? Alle Nachrichten darin gehen unwiderruflich verloren.`,
                          confirmLabel: "Löschen",
                          onConfirm: async () => {
                            setConfirmState(null);
                            setDeletingChannelId(c.id);
                            try {
                              await deleteChannel(c.id);
                            } catch (e) {
                              showToast(
                                e instanceof Error ? e.message : "Löschen fehlgeschlagen.",
                                "error"
                              );
                            } finally {
                              setDeletingChannelId(null);
                            }
                          },
                        })
                      }
                      className="btn-icon w-7 h-7 text-[var(--danger)]"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-[var(--foreground-secondary)] shrink-0">
                    {c.restricted ? "Eingeschränkt" : "Offen"}
                    {c.announcementOnly ? " · nur Admins schreiben" : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "emojis" && (
          <div>
            {isAdmin && (
              <>
                <input
                  ref={emojiInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleEmojiSelected}
                />
                <div className="flex gap-2 mb-4">
                  <div className="input-pill flex-1">
                    <input
                      value={newEmojiName}
                      onChange={(e) => setNewEmojiName(e.target.value)}
                      type="text"
                      placeholder="name (a-z, 0-9, _)"
                      maxLength={32}
                    />
                  </div>
                  <button
                    onClick={() => emojiInputRef.current?.click()}
                    disabled={uploadingEmoji || !newEmojiName.trim()}
                    className="btn-secondary text-sm shrink-0"
                  >
                    <Upload size={13} />
                    {uploadingEmoji ? "Lädt hoch…" : "Bild wählen"}
                  </button>
                </div>
              </>
            )}
            {customEmojis.length === 0 ? (
              <p className="text-sm text-[var(--foreground-secondary)]">
                Noch keine eigenen Emojis.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {customEmojis.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-subtle)]"
                  >
                    <Image
                      src={e.url}
                      alt={e.name}
                      width={22}
                      height={22}
                      className="rounded shrink-0"
                      unoptimized
                    />
                    <span className="text-xs text-[var(--foreground)] truncate flex-1">
                      :{e.name}:
                    </span>
                    {isAdmin && (
                      <button
                        type="button"
                        aria-label={`Emoji :${e.name}: löschen`}
                        disabled={removingEmojiId === e.id}
                        onClick={async () => {
                          setRemovingEmojiId(e.id);
                          try {
                            await removeServerEmoji(e.id);
                          } catch {
                            showToast("Löschen fehlgeschlagen.", "error");
                          } finally {
                            setRemovingEmojiId(null);
                          }
                        }}
                        className="btn-icon w-6 h-6 shrink-0 text-[var(--danger)]"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "roles" && (
          <div>
            <p className="text-xs text-[var(--foreground-secondary)] mb-4">
              Farbige Rollen-Tags zur Organisation deiner Mitglieder (z. B. &quot;Team&quot;,
              &quot;VIP&quot;) — sie gewähren keine zusätzlichen Rechte, das übernehmen weiterhin
              Owner/Admin/Member.
            </p>
            {isAdmin && (
              <div className="flex gap-2 mb-4">
                <div className="input-pill flex-1">
                  <input
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    type="text"
                    placeholder="z. B. Team"
                    maxLength={32}
                  />
                </div>
                <input
                  type="color"
                  value={newRoleColor}
                  onChange={(e) => setNewRoleColor(e.target.value)}
                  className="w-10 h-10 rounded-lg border border-[var(--border-subtle)] shrink-0 cursor-pointer bg-transparent"
                  aria-label="Farbe wählen"
                />
                <button
                  onClick={async () => {
                    if (!newRoleName.trim() || creatingRole) return;
                    setCreatingRole(true);
                    try {
                      await createServerRole(newRoleName, newRoleColor);
                      setNewRoleName("");
                    } catch {
                      showToast("Rolle konnte nicht erstellt werden.", "error");
                    } finally {
                      setCreatingRole(false);
                    }
                  }}
                  disabled={!newRoleName.trim() || creatingRole}
                  className="btn-secondary text-sm shrink-0"
                >
                  <Plus size={14} />
                  {creatingRole ? "…" : "Anlegen"}
                </button>
              </div>
            )}
            {serverRoles.length === 0 ? (
              <p className="text-sm text-[var(--foreground-secondary)]">
                Noch keine Rollen-Tags angelegt.
              </p>
            ) : (
              <div className="space-y-2">
                {serverRoles.map((role) => (
                  <div
                    key={role.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-subtle)]"
                  >
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: role.color }}
                    />
                    <span className="text-sm text-[var(--foreground)] flex-1 truncate">
                      {role.name}
                    </span>
                    {isAdmin && (
                      <button
                        type="button"
                        aria-label={`Rolle ${role.name} löschen`}
                        onClick={() => deleteServerRole(role.id)}
                        className="btn-icon w-7 h-7 shrink-0 text-[var(--danger)]"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    <ConfirmDialog
      isOpen={confirmState !== null}
      title={confirmState?.title || ""}
      message={confirmState?.message || ""}
      confirmLabel={confirmState?.confirmLabel || "Bestätigen"}
      busy={deleting || leaving || deletingChannelId !== null}
      onConfirm={() => confirmState?.onConfirm()}
      onCancel={() => setConfirmState(null)}
    />
    <NewsBotSetupModal
      isOpen={newsBotSetupOpen}
      onClose={() => setNewsBotSetupOpen(false)}
    />
    </>,
    document.body
  );
}
