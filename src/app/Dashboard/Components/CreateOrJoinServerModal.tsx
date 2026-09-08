"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useUser } from "@/app/Context/UserContext";
import { useServer } from "@/app/Context/ServerContext";
import { useChannel } from "@/app/Context/ChannelContext";
import { useToast } from "@/app/Context/ToastContext";
import { uploadImage, ImageValidationError } from "@/app/lib/uploadImage";
import { X, Upload, Link as LinkIcon, Plus, Trash2, Hash, Copy } from "lucide-react";

let channelRowId = 0;
function nextChannelRowId() {
  channelRowId += 1;
  return channelRowId;
}

type ChannelDraft = {
  id: number;
  name: string;
  restricted: boolean;
  announcementOnly: boolean;
};

export default function CreateOrJoinServerModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<"create" | "join">("create");
  const { user } = useUser();
  const { createServer, createInvite, joinServerByInviteCode } = useServer();
  const { createChannel } = useChannel();
  const { showToast } = useToast();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [bannerUrl, setBannerUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [channels, setChannels] = useState<ChannelDraft[]>([
    { id: nextChannelRowId(), name: "allgemein", restricted: false, announcementOnly: false },
  ]);
  const [createdInviteCode, setCreatedInviteCode] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (isOpen) {
      setTab(user?.isGuest ? "join" : "create");
      setName("");
      setDescription("");
      setIconUrl("");
      setBannerUrl("");
      setInviteCode("");
      setCreatedInviteCode(null);
      setChannels([
        { id: nextChannelRowId(), name: "allgemein", restricted: false, announcementOnly: false },
      ]);
    }
  }, [isOpen, user?.isGuest]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handleFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (
    e
  ) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    setUploading(true);
    try {
      const url = await uploadImage(file, `serverIcons/${user.id}_${Date.now()}`);
      setIconUrl(url);
    } catch (err) {
      console.error("[CreateOrJoinServerModal] Icon-Upload fehlgeschlagen:", err);
      showToast(
        err instanceof ImageValidationError
          ? err.message
          : "Hochladen fehlgeschlagen. Bitte erneut versuchen.",
        "error"
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleBannerSelected: React.ChangeEventHandler<HTMLInputElement> = async (
    e
  ) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    setUploadingBanner(true);
    try {
      const url = await uploadImage(file, `serverBanners/${user.id}_${Date.now()}`);
      setBannerUrl(url);
    } catch (err) {
      console.error("[CreateOrJoinServerModal] Banner-Upload fehlgeschlagen:", err);
      showToast(
        err instanceof ImageValidationError
          ? err.message
          : "Hochladen fehlgeschlagen. Bitte erneut versuchen.",
        "error"
      );
    } finally {
      setUploadingBanner(false);
      if (bannerInputRef.current) bannerInputRef.current.value = "";
    }
  };

  function addChannelRow() {
    setChannels((prev) => [
      ...prev,
      { id: nextChannelRowId(), name: "", restricted: false, announcementOnly: false },
    ]);
  }

  function removeChannelRow(id: number) {
    setChannels((prev) => prev.filter((c) => c.id !== id));
  }

  function updateChannelRow(id: number, patch: Partial<ChannelDraft>) {
    setChannels((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c))
    );
  }

  async function handleCreate() {
    if (!name.trim() || creating || user?.isGuest) return;
    setCreating(true);
    try {
      const serverId = await createServer(
        name,
        iconUrl || undefined,
        bannerUrl || undefined,
        description || undefined
      );

      const validChannels = channels.filter((c) => c.name.trim());
      for (const c of validChannels) {
        try {
          await createChannel(c.name, undefined, c.restricted, {
            serverIdOverride: serverId,
            skipRateLimit: true,
            announcementOnly: c.announcementOnly,
          });
        } catch (e) {
          console.error("[CreateOrJoinServerModal] Kanal-Erstellung fehlgeschlagen:", e);
          showToast(`Kanal "${c.name}" konnte nicht erstellt werden.`, "error");
        }
      }

      try {
        const code = await createInvite(serverId, {
          expiresInMs: 7 * 24 * 60 * 60 * 1000,
        });
        setCreatedInviteCode(code);
      } catch (e) {
        console.error("[CreateOrJoinServerModal] Einladungslink fehlgeschlagen:", e);
        onClose();
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Fehler beim Erstellen.", "error");
    } finally {
      setCreating(false);
    }
  }

  function copyCreatedInvite() {
    if (!createdInviteCode) return;
    const link = `${window.location.origin}/invite/${createdInviteCode}`;
    navigator.clipboard
      .writeText(link)
      .then(() => showToast("Einladungslink kopiert.", "success"))
      .catch(() => showToast(link, "info"));
  }

  async function handleJoin() {
    if (!inviteCode.trim() || joining) return;
    setJoining(true);
    try {
      const joined = await joinServerByInviteCode(inviteCode);
      if (joined) onClose();
    } finally {
      setJoining(false);
    }
  }

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Server erstellen oder beitreten"
    >
      <div className="modal-card w-full max-w-[520px] max-h-[85vh] overflow-y-auto p-6 sm:p-8">
        <button
          onClick={onClose}
          className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label="Modal schließen"
        >
          <X size={18} />
        </button>

        <h2 className="text-xl sm:text-2xl font-semibold mb-6 text-[var(--foreground)]">
          Server
        </h2>

        <div className="flex gap-1 mb-6 border-b border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => !user?.isGuest && setTab("create")}
            disabled={user?.isGuest}
            title={user?.isGuest ? "Nur für registrierte Nutzer verfügbar" : undefined}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              user?.isGuest
                ? "border-transparent text-[var(--foreground-secondary)] opacity-40 cursor-not-allowed"
                : tab === "create"
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
            }`}
          >
            Server erstellen
          </button>
          <button
            type="button"
            onClick={() => setTab("join")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === "join"
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
            }`}
          >
            Server beitreten
          </button>
        </div>

        {tab === "create" && createdInviteCode ? (
          <div>
            <p className="text-sm text-[var(--foreground)] mb-4">
              <strong>{name}</strong> wurde erstellt! Teile diesen Link, damit andere
              beitreten können (läuft nach 7 Tagen ab, in den Server-Einstellungen kannst
              du jederzeit weitere erstellen):
            </p>
            <div className="input-pill mb-6">
              <LinkIcon size={14} className="text-[var(--foreground-secondary)]" />
              <input
                readOnly
                value={`${typeof window !== "undefined" ? window.location.origin : ""}/invite/${createdInviteCode}`}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <button
                type="button"
                onClick={copyCreatedInvite}
                className="btn-icon w-7 h-7 shrink-0"
                aria-label="Link kopieren"
              >
                <Copy size={13} />
              </button>
            </div>
            <div className="flex justify-end">
              <button onClick={onClose} className="btn-primary">
                Fertig
              </button>
            </div>
          </div>
        ) : tab === "create" ? (
          <div>
            <div className="flex items-center gap-4 mb-4">
              <div className="w-16 h-16 rounded-full overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shrink-0 relative">
                {iconUrl && (
                  <Image src={iconUrl} alt="Server-Icon" fill className="object-cover" />
                )}
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="btn-secondary text-sm"
                >
                  <Upload size={14} />
                  {uploading ? "Wird hochgeladen…" : "Icon hochladen (optional)"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileSelected}
                />
              </div>
            </div>

            <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
              Server-Name
            </label>
            <div className="input-pill">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                type="text"
                placeholder="z. B. Mein Team"
              />
            </div>

            <label className="block font-medium text-sm mb-1 mt-4 text-[var(--foreground)]">
              Beschreibung (optional)
            </label>
            <div className="input-pill">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                type="text"
                placeholder="Worum geht's hier?"
                maxLength={200}
              />
            </div>

            <div className="mt-4">
              <div
                className="h-20 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] bg-cover bg-center flex items-center justify-center relative overflow-hidden"
                style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}
              >
                <button
                  type="button"
                  onClick={() => bannerInputRef.current?.click()}
                  disabled={uploadingBanner}
                  className="btn-secondary text-xs px-2.5 py-1.5"
                >
                  <Upload size={13} />
                  {uploadingBanner
                    ? "Lädt hoch…"
                    : bannerUrl
                    ? "Banner ändern"
                    : "Banner hochladen (optional)"}
                </button>
              </div>
              <input
                ref={bannerInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleBannerSelected}
              />
            </div>

            <div className="mt-6">
              <label className="block font-medium text-sm mb-2 text-[var(--foreground)]">
                Channels
              </label>
              <div className="space-y-2">
                {channels.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <div className="input-pill flex-1">
                      <Hash size={14} className="text-[var(--foreground-secondary)]" />
                      <input
                        value={c.name}
                        onChange={(e) => updateChannelRow(c.id, { name: e.target.value })}
                        type="text"
                        placeholder="channel-name"
                      />
                    </div>
                    <label
                      className="flex items-center gap-1.5 text-xs text-[var(--foreground-secondary)] shrink-0 cursor-pointer"
                      title="Nur eingeladene Mitglieder sehen diesen Channel"
                    >
                      <input
                        type="checkbox"
                        checked={c.restricted}
                        onChange={(e) =>
                          updateChannelRow(c.id, { restricted: e.target.checked })
                        }
                      />
                      Eingeschränkt
                    </label>
                    <label
                      className="flex items-center gap-1.5 text-xs text-[var(--foreground-secondary)] shrink-0 cursor-pointer"
                      title="Nur Owner/Admin können hier schreiben"
                    >
                      <input
                        type="checkbox"
                        checked={c.announcementOnly}
                        onChange={(e) =>
                          updateChannelRow(c.id, { announcementOnly: e.target.checked })
                        }
                      />
                      Nur Admins schreiben
                    </label>
                    {channels.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeChannelRow(c.id)}
                        className="btn-icon w-7 h-7 shrink-0 text-[var(--foreground-secondary)]"
                        aria-label="Channel entfernen"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addChannelRow}
                className="btn-secondary text-xs px-2.5 py-1.5 mt-2"
              >
                <Plus size={13} />
                Channel hinzufügen
              </button>
            </div>

            <div className="mt-8 flex justify-end gap-3">
              <button onClick={onClose} className="btn-secondary">
                Abbrechen
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !name.trim()}
                className="btn-primary"
              >
                {creating ? "Erstellt…" : "Erstellen"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
              Einladungslink oder -code
            </label>
            <div className="input-pill">
              <LinkIcon size={16} className="text-[var(--foreground-secondary)]" />
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                type="text"
                placeholder="z. B. https://.../invite/abc123"
              />
            </div>

            <div className="mt-8 flex justify-end gap-3">
              <button onClick={onClose} className="btn-secondary">
                Abbrechen
              </button>
              <button
                onClick={handleJoin}
                disabled={joining || !inviteCode.trim()}
                className="btn-primary"
              >
                {joining ? "Tritt bei…" : "Beitreten"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
