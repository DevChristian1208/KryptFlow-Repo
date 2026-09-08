"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, ZoomIn } from "lucide-react";

const PREVIEW_SIZE = 280;
const OUTPUT_SIZE = 512;

type Props = {
  file: File | null;
  onCancel: () => void;
  onCropped: (blob: Blob) => void;
};

export default function AvatarCropModal({ file, onCancel, onCropped }: Props) {
  const [mounted, setMounted] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; origin: { x: number; y: number } } | null>(
    null
  );
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!file) {
      setImgUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const baseScale = useMemo(() => {
    if (!naturalSize.w || !naturalSize.h) return 1;
    return Math.max(PREVIEW_SIZE / naturalSize.w, PREVIEW_SIZE / naturalSize.h);
  }, [naturalSize]);

  const effectiveScale = baseScale * zoom;
  const drawnW = naturalSize.w * effectiveScale;
  const drawnH = naturalSize.h * effectiveScale;
  const maxOffsetX = Math.max(0, (drawnW - PREVIEW_SIZE) / 2);
  const maxOffsetY = Math.max(0, (drawnH - PREVIEW_SIZE) / 2);

  function clamp(o: { x: number; y: number }) {
    return {
      x: Math.min(maxOffsetX, Math.max(-maxOffsetX, o.x)),
      y: Math.min(maxOffsetY, Math.max(-maxOffsetY, o.y)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, origin: offset };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setOffset(clamp({ x: dragState.current.origin.x + dx, y: dragState.current.origin.y + dy }));
  }
  function onPointerUp() {
    dragState.current = null;
  }

  async function handleConfirm() {
    if (!imgRef.current || !naturalSize.w) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const ratio = OUTPUT_SIZE / PREVIEW_SIZE;
    const outScale = effectiveScale * ratio;
    const outW = naturalSize.w * outScale;
    const outH = naturalSize.h * outScale;
    const outX = OUTPUT_SIZE / 2 - outW / 2 + offset.x * ratio;
    const outY = OUTPUT_SIZE / 2 - outH / 2 + offset.y * ratio;

    ctx.drawImage(imgRef.current, outX, outY, outW, outH);
    canvas.toBlob(
      (blob) => {
        if (blob) onCropped(blob);
      },
      "image/jpeg",
      0.92
    );
  }

  if (!file || !imgUrl || !mounted) return null;

  return createPortal(
    <div className="modal-overlay z-[80]" role="dialog" aria-modal="true" aria-label="Profilbild zuschneiden">
      <div className="modal-card w-full max-w-[380px] p-6 flex flex-col items-center">
        <button
          onClick={onCancel}
          className="btn-icon absolute top-4 right-4 w-8 h-8 text-[var(--foreground-secondary)]"
          aria-label="Abbrechen"
        >
          <X size={16} />
        </button>

        <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4 self-start">
          Bild zuschneiden
        </h2>

        <div
          className="relative rounded-full overflow-hidden border border-[var(--border-subtle)] cursor-grab active:cursor-grabbing touch-none select-none"
          style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={imgUrl}
            alt="Zuschneiden"
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNaturalSize({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            className="absolute top-1/2 left-1/2 max-w-none pointer-events-none"
            style={{
              width: drawnW || undefined,
              height: drawnH || undefined,
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
            }}
          />
        </div>

        <div className="flex items-center gap-2 w-full mt-4">
          <ZoomIn size={16} className="text-[var(--foreground-secondary)] shrink-0" />
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => {
              const next = Number(e.target.value);
              setZoom(next);
              setOffset((o) => clamp(o));
            }}
            className="flex-1"
          />
        </div>

        <div className="flex justify-end gap-3 mt-6 w-full">
          <button onClick={onCancel} className="btn-secondary">
            Abbrechen
          </button>
          <button onClick={handleConfirm} className="btn-primary">
            <Check size={15} />
            Übernehmen
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
