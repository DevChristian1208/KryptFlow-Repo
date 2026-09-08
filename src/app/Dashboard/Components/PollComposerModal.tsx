"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Trash2, BarChart3 } from "lucide-react";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[]) => Promise<void>;
};

export default function PollComposerModal({ isOpen, onClose, onCreate }: Props) {
  const [mounted, setMounted] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [creating, setCreating] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (isOpen) {
      setQuestion("");
      setOptions(["", ""]);
    }
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const validOptions = options.map((o) => o.trim()).filter(Boolean);
  const canCreate = question.trim().length > 0 && validOptions.length >= 2;

  function updateOption(i: number, value: string) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
  }

  function removeOption(i: number) {
    setOptions((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleCreate() {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      await onCreate(question.trim(), validOptions);
      onClose();
    } finally {
      setCreating(false);
    }
  }

  return createPortal(
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Umfrage erstellen"
    >
      <div className="modal-card w-full max-w-[440px] p-6 sm:p-7">
        <button
          onClick={onClose}
          className="btn-icon absolute top-4 right-4 w-8 h-8 text-[var(--foreground-secondary)]"
          aria-label="Dialog schließen"
        >
          <X size={16} />
        </button>

        <div className="flex items-center gap-2 mb-4">
          <BarChart3 size={20} className="text-[var(--accent)] shrink-0" />
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            Umfrage erstellen
          </h2>
        </div>

        <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
          Frage
        </label>
        <div className="input-pill mb-4">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            type="text"
            placeholder="z. B. Welcher Termin passt am besten?"
            maxLength={200}
          />
        </div>

        <label className="block font-medium text-sm mb-2 text-[var(--foreground)]">
          Optionen
        </label>
        <div className="space-y-2 mb-2">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="input-pill flex-1">
                <input
                  value={o}
                  onChange={(e) => updateOption(i, e.target.value)}
                  type="text"
                  placeholder={`Option ${i + 1}`}
                  maxLength={80}
                />
              </div>
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  className="btn-icon w-7 h-7 shrink-0 text-[var(--foreground-secondary)]"
                  aria-label="Option entfernen"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {options.length < 6 && (
          <button
            type="button"
            onClick={() => setOptions((prev) => [...prev, ""])}
            className="btn-secondary text-xs px-2.5 py-1.5"
          >
            <Plus size={13} />
            Option hinzufügen
          </button>
        )}

        <div className="mt-8 flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary" disabled={creating}>
            Abbrechen
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate || creating}
            className="btn-primary"
          >
            {creating ? "Erstellt…" : "Umfrage senden"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
