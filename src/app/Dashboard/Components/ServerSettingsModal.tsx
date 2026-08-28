"use client";

import { useEffect, useState } from "react";
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
} from "lucide-react";

type Tab = "overview" | "members" | "invites" | "channels";

type MemberRow = {
  uid: string;
  role: ServerRole;
  name: string;
  avatar?: string;
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
    deleteServer,
    updateMemberRole,
    removeMember,
    createInvite,
    inviteUserToServer,
    setActiveServerId,
  } = useServer();
  const { channels, setChannelRestricted } = useChannel();
  const { sendDirectSystemMessage } = useDirect();

  const [name, setName] = useState(server.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [members, setMembers] = useState<MemberRow[]>([]);
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
      const raw = (snap.val() as Record<string, { role?: ServerRole }> | null) || {};
      (async () => {
        const rows = await Promise.all(
          Object.entries(raw).map(async ([uid, v]) => {
            if (user && uid === user.id) {
              return {
                uid,
                role: v.role || "member",
                name: user.name,
                avatar: user.avatar,
              };
            }
            const uSnap = await get(ref(db, `newusers/${uid}`));
            const u = uSnap.val() as NewUserDb | null;
            return {
              uid,
              role: v.role || "member",
              name: u?.newname || "Unbekannt",
              avatar: u?.avatar,
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

  async function handleDelete() {
    if (deleting) return;
    if (!window.confirm(`„${server.name}" wirklich endgültig löschen?`)) return;
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
  ];

  return createPortal(
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Server-Einstellungen"
    >
      <div className="modal-card w-full max-w-[640px] p-6 sm:p-8">
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

            {isOwner && (
              <div className="pt-6 border-t border-[var(--border-subtle)]">
                <h3 className="text-sm font-semibold text-[var(--danger)] uppercase tracking-wide mb-3 flex items-center gap-2">
                  <TriangleAlert size={14} /> Danger Zone
                </h3>
                <p className="text-sm text-[var(--foreground-secondary)] mb-3">
                  Löscht den Server, alle seine Kanäle und Nachrichten dauerhaft.
                </p>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="btn-secondary text-[var(--danger)] border-[var(--danger)]"
                >
                  {deleting ? "Wird gelöscht…" : "Server löschen"}
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
                        className="rounded-full shrink-0"
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
                    className="rounded-full"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate text-[var(--foreground)]">
                      {m.name} {isSelf && <span className="text-xs text-[var(--foreground-secondary)]">(Du)</span>}
                    </div>
                    <div className="text-xs text-[var(--foreground-secondary)] capitalize">
                      {m.role}
                    </div>
                  </div>
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
                    <button
                      onClick={() => removeMember(server.id, m.uid)}
                      className="btn-secondary text-[var(--danger)] border-[var(--danger)] text-xs px-3 py-1.5"
                    >
                      Entfernen
                    </button>
                  )}
                </div>
              );
            })}
            </div>
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
                  <label className="flex items-center gap-2 text-xs text-[var(--foreground-secondary)] cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      checked={!!c.restricted}
                      onChange={(e) => setChannelRestricted(c.id, e.target.checked)}
                      className="accent-[var(--accent)]"
                    />
                    Eingeschränkt
                  </label>
                ) : (
                  <span className="text-xs text-[var(--foreground-secondary)] shrink-0">
                    {c.restricted ? "Eingeschränkt" : "Offen"}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
