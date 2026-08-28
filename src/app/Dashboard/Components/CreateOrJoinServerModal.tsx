"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useUser } from "@/app/Context/UserContext";
import { useServer } from "@/app/Context/ServerContext";
import { useToast } from "@/app/Context/ToastContext";
import { uploadImage, ImageValidationError } from "@/app/lib/uploadImage";
import { X, Upload, Link as LinkIcon } from "lucide-react";

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
  const { createServer, joinServerByInviteCode } = useServer();
  const { showToast } = useToast();

  const [name, setName] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (isOpen) {
      setTab("create");
      setName("");
      setIconUrl("");
      setInviteCode("");
    }
  }, [isOpen]);
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

  async function handleCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await createServer(name, iconUrl || undefined);
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Fehler beim Erstellen.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleJoin() {
    if (!inviteCode.trim() || joining) return;
    setJoining(true);
    try {
      await joinServerByInviteCode(inviteCode);
      onClose();
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
      <div className="modal-card w-full max-w-[520px] p-6 sm:p-8">
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
            onClick={() => setTab("create")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === "create"
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

        {tab === "create" ? (
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
