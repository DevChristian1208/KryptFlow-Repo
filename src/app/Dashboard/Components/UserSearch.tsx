"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ref, query, orderByChild, startAt, endAt, get, set } from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "@/app/Context/UserContext";
import { useDirect } from "@/app/Context/DirectContext";
import { useToast } from "@/app/Context/ToastContext";
import { Search, X, UserPlus, Ban } from "lucide-react";

type SearchResult = { id: string; name: string; username: string; avatar?: string };

type NewUserDb = {
  authUid?: string;
  newname?: string;
  username?: string;
  avatar?: string;
};

export default function UserSearch() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);

  const { user: me } = useUser();
  const { startDMWith, isBlocked, blockUser } = useDirect();
  const { showToast } = useToast();
  const [sentRequests, setSentRequests] = useState<Set<string>>(new Set());

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Fest positioniert relativ zum Viewport statt relativ zur Sidebar (per
  // Portal gerendert) — die Sidebar-Breite ist seit der Ziehgriff-
  // Funktion variabel und teils schmaler als das Popover selbst, ein
  // `position: absolute` relativ zur Sidebar würde dann über deren Rand
  // hinausragen bzw. abgeschnitten werden.
  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setCoords({
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!open) return;
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    const cleaned = term.trim().toLowerCase();
    if (!cleaned) {
      setResults([]);
      return;
    }

    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const q = query(
          ref(db, "newusers"),
          orderByChild("username"),
          startAt(cleaned),
          endAt(cleaned + "")
        );
        const snap = await get(q);
        const val = (snap.val() as Record<string, NewUserDb> | null) || {};
        const list: SearchResult[] = Object.values(val)
          .filter(
            (u) =>
              u.authUid &&
              u.authUid !== me?.id &&
              u.username &&
              !isBlocked(u.authUid)
          )
          .map((u) => ({
            id: u.authUid!,
            name: u.newname || "Unbekannt",
            username: u.username!,
            avatar: u.avatar,
          }));
        setResults(list);
      } catch (e) {
        console.error("[UserSearch] Suche fehlgeschlagen:", e);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(handle);
  }, [term, me?.id, isBlocked]);

  const handleSelect = (uid: string) => {
    startDMWith(uid);
    setOpen(false);
    setTerm("");
  };

  const handleAddFriend = async (r: SearchResult) => {
    if (!me?.id) return;
    try {
      await set(ref(db, `friendRequests/${r.id}/${me.id}`), {
        fromName: me.name || "Unbekannt",
        fromAvatar: me.avatar || null,
        createdAt: Date.now(),
      });
      setSentRequests((prev) => new Set(prev).add(r.id));
      showToast(`Freundschaftsanfrage an ${r.name} gesendet.`, "success");
    } catch {
      showToast("Anfrage konnte nicht gesendet werden.", "error");
    }
  };

  const handleBlock = async (r: SearchResult) => {
    try {
      await blockUser(r.id);
      setResults((prev) => prev.filter((x) => x.id !== r.id));
      showToast(`${r.name} wurde blockiert.`, "success");
    } catch {
      showToast("Blockieren fehlgeschlagen.", "error");
    }
  };

  const popover =
    open && mounted && coords ? (
      <div
        ref={popoverRef}
        className="card-surface fixed z-[100] w-64 p-3"
        style={{ top: coords.top, right: coords.right }}
      >
        <div className="input-pill mb-2">
            <Search size={14} className="text-[var(--foreground-secondary)]" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Benutzername suchen…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
            {term && (
              <button
                type="button"
                onClick={() => setTerm("")}
                className="btn-icon w-5 h-5 shrink-0"
                aria-label="Suche leeren"
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div className="max-h-56 overflow-y-auto space-y-1">
            {loading && (
              <p className="text-xs text-[var(--foreground-secondary)] px-2 py-1">
                Suche…
              </p>
            )}
            {!loading && term.trim() && results.length === 0 && (
              <p className="text-xs text-[var(--foreground-secondary)] px-2 py-1">
                Keine Treffer.
              </p>
            )}
            {results.map((r) => (
              <div
                key={r.id}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--border-subtle)] transition"
              >
                <button
                  type="button"
                  onClick={() => handleSelect(r.id)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  <Image
                    src={r.avatar || "/avatar1.png"}
                    alt={r.name}
                    width={26}
                    height={26}
                    className="rounded-full shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-[var(--foreground)]">{r.name}</div>
                    <div className="truncate text-xs text-[var(--foreground-secondary)]">
                      @{r.username}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleAddFriend(r)}
                  disabled={sentRequests.has(r.id)}
                  className="btn-icon w-6 h-6 shrink-0 text-[var(--foreground-secondary)] disabled:opacity-40"
                  aria-label="Freund hinzufügen"
                  title="Freund hinzufügen"
                >
                  <UserPlus size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => handleBlock(r)}
                  className="btn-icon w-6 h-6 shrink-0 text-[var(--foreground-secondary)] hover:text-[var(--danger)]"
                  aria-label="Blockieren"
                  title="Blockieren"
                >
                  <Ban size={13} />
                </button>
              </div>
            ))}
          </div>
      </div>
    ) : null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-icon w-7 h-7"
        aria-label="Nutzer suchen"
      >
        <Search size={16} />
      </button>

      {mounted && popover && createPortal(popover, document.body)}
    </div>
  );
}
