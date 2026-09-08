"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { X, Bookmark, Trash2, ArrowRight, Hash, User as UserIcon } from "lucide-react";
import { useSavedMessages } from "@/app/Context/SavedMessagesContext";
import { useChannel } from "@/app/Context/ChannelContext";
import { useDirect } from "@/app/Context/DirectContext";

function formatTime(ts?: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SavedMessagesModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const { savedMessages, unsaveMessage, loading } = useSavedMessages();
  const { setActiveChannelId } = useChannel();
  const { startDMWith } = useDirect();

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen || !mounted) return null;

  function jumpTo(m: (typeof savedMessages)[number]) {
    if (m.sourceKind === "channel" && m.channelId) {
      setActiveChannelId(m.channelId);
    } else if (m.sourceKind === "dm" && m.otherUid) {
      startDMWith(m.otherUid);
    }
    onClose();
  }

  return createPortal(
    <div
      className="modal-overlay z-[60]"
      onClick={(e) => e.currentTarget === e.target && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Gespeicherte Nachrichten"
    >
      <div className="modal-card w-full max-w-[520px] max-h-[80vh] overflow-y-auto p-6 sm:p-8">
        <button
          onClick={onClose}
          className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label="Modal schließen"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-2 mb-6">
          <Bookmark size={20} className="text-[var(--accent)] shrink-0" />
          <h2 className="text-xl sm:text-2xl font-semibold text-[var(--foreground)]">
            Gespeicherte Nachrichten
          </h2>
        </div>

        {loading ? (
          <p className="text-sm text-[var(--foreground-secondary)] text-center py-10">
            Lädt…
          </p>
        ) : savedMessages.length === 0 ? (
          <p className="text-sm text-[var(--foreground-secondary)] text-center py-10">
            Noch keine Nachrichten gespeichert. Fahre in einem Chat über eine Nachricht
            und klicke auf das Lesezeichen-Symbol.
          </p>
        ) : (
          <div className="space-y-3">
            {savedMessages.map((m) => (
              <div
                key={m.id}
                className="card-surface p-3"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Image
                    src={m.senderAvatar || "/avatar1.png"}
                    alt={m.senderName}
                    width={20}
                    height={20}
                    className="w-5 h-5 rounded-full object-cover shrink-0"
                  />
                  <span className="text-sm font-medium text-[var(--foreground)] truncate">
                    {m.senderName}
                  </span>
                  <span className="text-xs text-[var(--foreground-secondary)] shrink-0">
                    {formatTime(m.originalCreatedAt)}
                  </span>
                </div>
                <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap break-words mb-2">
                  {m.text}
                </p>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => jumpTo(m)}
                    className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-80 transition"
                  >
                    {m.sourceKind === "channel" ? (
                      <Hash size={12} />
                    ) : (
                      <UserIcon size={12} />
                    )}
                    {m.sourceKind === "channel" ? m.channelName : m.otherName}
                    <ArrowRight size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => unsaveMessage(m.id)}
                    className="btn-icon w-7 h-7 shrink-0 text-[var(--danger)]"
                    aria-label="Aus Gespeichert entfernen"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
