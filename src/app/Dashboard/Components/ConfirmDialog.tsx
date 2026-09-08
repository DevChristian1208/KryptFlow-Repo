"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert, X } from "lucide-react";

type Props = {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = "Bestätigen",
  cancelLabel = "Abbrechen",
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onCancel]);

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="modal-overlay z-[80]"
      onClick={(e) => e.currentTarget === e.target && onCancel()}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal-card w-full max-w-[420px] p-6 sm:p-7">
        <button
          onClick={onCancel}
          className="btn-icon absolute top-4 right-4 w-8 h-8 text-[var(--foreground-secondary)]"
          aria-label="Dialog schließen"
        >
          <X size={16} />
        </button>

        <div className="flex items-center gap-2 mb-2">
          {danger && <TriangleAlert size={20} className="text-[var(--danger)] shrink-0" />}
          <h2 className="text-lg font-semibold text-[var(--foreground)]">{title}</h2>
        </div>
        <p className="text-sm text-[var(--foreground-secondary)] mb-6">{message}</p>

        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="btn-secondary" disabled={busy}>
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="btn-primary"
            style={danger ? { background: "var(--danger)" } : undefined}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
