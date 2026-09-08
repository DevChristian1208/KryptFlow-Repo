"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

type Meta = { title?: string; description?: string; image?: string; siteName?: string };

// Modulweiter Cache statt pro Komponente: dieselbe URL taucht oft in
// mehreren Nachrichten/Renders auf, ein erneuter Server-Roundtrip pro
// Vorkommen wäre unnötig.
const cache = new Map<string, Promise<Meta | null>>();

function fetchMeta(url: string): Promise<Meta | null> {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    );
  }
  return cache.get(url)!;
}

export default function LinkPreview({ url }: { url: string }) {
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setMeta(undefined);
    fetchMeta(url).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!meta || (!meta.title && !meta.description && !meta.image)) return null;

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-1.5 flex gap-3 max-w-sm rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] overflow-hidden hover:bg-[color-mix(in_srgb,var(--foreground)_4%,var(--surface-elevated))] transition"
    >
      {meta.image && (
        <div className="relative w-20 h-20 shrink-0 bg-[var(--border-subtle)]">
          <Image src={meta.image} alt="" fill className="object-cover" unoptimized />
        </div>
      )}
      <div className="min-w-0 py-2 pr-3 flex flex-col justify-center">
        <span className="text-[11px] text-[var(--foreground-secondary)] truncate">
          {meta.siteName || host}
        </span>
        {meta.title && (
          <span className="text-sm font-medium text-[var(--foreground)] truncate">
            {meta.title}
          </span>
        )}
        {meta.description && (
          <span className="text-xs text-[var(--foreground-secondary)] line-clamp-2">
            {meta.description}
          </span>
        )}
      </div>
    </a>
  );
}
