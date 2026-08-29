"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useChannel } from "@/app/Context/ChannelContext";
import { X } from "lucide-react";

export default function AddChannelModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { createChannel, loading, error } = useChannel();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  async function submit() {
    if (!name.trim()) return;
    try {
      await createChannel(name, desc, restricted);
      setName("");
      setDesc("");
      setRestricted(false);
      onClose();
    } catch {}
  }

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Channel erstellen"
    >
      <div className="modal-card w-full max-w-[872px] max-h-[85vh] overflow-y-auto p-6 sm:p-8">
        <button
          onClick={onClose}
          className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label="Modal schließen"
        >
          <X size={18} />
        </button>

        <h2 className="text-xl sm:text-2xl font-semibold mb-2 text-[var(--foreground)]">
          Channel erstellen
        </h2>
        <p className="text-sm text-[var(--foreground-secondary)] mb-6">
          Lege einen themenbezogenen Channel an – z. B.{" "}
          <span className="font-medium text-[var(--accent)]">#marketing</span>.
        </p>

        <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
          Channel-Name
        </label>
        <div className="input-pill">
          <span className="text-[var(--foreground-secondary)]">#</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            type="text"
            placeholder="z. B. kooperationsprojekte"
          />
        </div>

        <label className="block font-medium text-sm mt-5 mb-1 text-[var(--foreground)]">
          Beschreibung{" "}
          <span className="text-[var(--foreground-secondary)]">
            (optional)
          </span>
        </label>
        <div className="input-pill">
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            type="text"
            placeholder="Dein Text hier"
          />
        </div>

        <label className="flex items-center gap-2 mt-5 text-sm text-[var(--foreground-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={restricted}
            onChange={(e) => setRestricted(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Eingeschränkter Kanal (nur explizit eingeladene Mitglieder statt aller
          Server-Mitglieder)
        </label>

        {error && (
          <p className="text-sm mt-3" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <div className="mt-8 flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary">
            Abbrechen
          </button>
          <button
            onClick={submit}
            disabled={loading || !name.trim()}
            className="btn-primary"
          >
            {loading ? "Erstelle…" : "Erstellen"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
