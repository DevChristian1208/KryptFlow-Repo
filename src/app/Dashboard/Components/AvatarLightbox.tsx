"use client";

import { useEffect } from "react";
import Image from "next/image";
import { X } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  src: string;
  alt: string;
  size?: number;
};

export default function AvatarLightbox({
  open,
  onClose,
  src,
  alt,
  size = 220,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay z-[70]" onClick={onClose}>
      <div
        className="relative flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          className="absolute -top-3 -right-3 btn-icon w-8 h-8 bg-[var(--modal-surface)] border border-[var(--border-subtle)]"
        >
          <X size={16} />
        </button>
        <div
          className="rounded-full overflow-hidden border border-[var(--border-subtle)] shadow-[0_20px_60px_rgba(0,0,0,0.35)] relative"
          style={{ width: size, height: size }}
        >
          <Image src={src} alt={alt} fill sizes={`${size}px`} className="object-cover" />
        </div>
      </div>
    </div>
  );
}
