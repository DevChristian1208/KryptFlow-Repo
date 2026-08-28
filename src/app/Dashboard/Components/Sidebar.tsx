"use client";

import { useCallback, useEffect, useRef, useState, KeyboardEvent } from "react";
import Image from "next/image";
import { useUser } from "@/app/Context/UserContext";
import { useChannel } from "@/app/Context/ChannelContext";
import { useDirect } from "@/app/Context/DirectContext";
import { usePresence } from "@/app/Context/PresenceContext";
import { useNotifications } from "@/app/Context/NotificationContext";
import { useServer } from "@/app/Context/ServerContext";
import AddChannelModal from "./AddChannelModal";
import ServerSettingsModal from "./ServerSettingsModal";
import ServerRail from "./ServerRail";
import UserSearch from "./UserSearch";
import {
  Pencil,
  Plus,
  ChevronDown,
  Hash,
  User,
  Users,
} from "lucide-react";
import { useToast } from "@/app/Context/ToastContext";

type SidebarProps = {
  open?: boolean;
  onToggleSidebar: () => void;
};

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 320;
const SIDEBAR_WIDTH_STORAGE_KEY = "cryptflow_sidebar_width";

export default function Sidebar({
  open = true,
  onToggleSidebar,
}: SidebarProps) {
  const [showModal, setShowModal] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [friendsOpen, setFriendsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);

  // Breite der Kanal-/DM-Spalte per Ziehgriff einstellbar, wird pro Browser
  // gemerkt (localStorage) — die Server-Rail selbst hat eine feste Breite.
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const widthRef = useRef(DEFAULT_SIDEBAR_WIDTH);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
      const n = stored ? parseInt(stored, 10) : NaN;
      if (!Number.isNaN(n)) {
        const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, n));
        setSidebarWidth(clamped);
        widthRef.current = clamped;
      }
    } catch {}
  }, []);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizingRef.current) return;
    const delta = e.clientX - startXRef.current;
    const next = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, startWidthRef.current + delta)
    );
    widthRef.current = next;
    setSidebarWidth(next);
  }, []);

  const handleResizeEnd = useCallback(() => {
    resizingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", handleResizeMove);
    window.removeEventListener("mouseup", handleResizeEnd);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(widthRef.current));
    } catch {}
  }, [handleResizeMove]);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleResizeMove);
    window.addEventListener("mouseup", handleResizeEnd);
  };

  const { user } = useUser();
  const { showToast } = useToast();
  const { channels, activeChannelId, setActiveChannelId } = useChannel();
  const { activeServer } = useServer();
  const {
    dmThreads = [],
    startDMWith,
    activeDMUserId,
    clearDM,
    unreadCounts,
    friends,
  } = useDirect();
  const { onlineUids } = usePresence();
  const { unreadMentionsByChannel } = useNotifications();

  const closeOnMobile = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      onToggleSidebar?.();
    }
  };

  const handleSelectChannel = (id: string) => {
    setActiveChannelId(id);
    clearDM?.();
    closeOnMobile();
  };

  const handleOpenDM = (otherUserId: string) => {
    if (user?.isGuest) {
      showToast("Dieses Feature ist nur für registrierte Nutzer verfügbar.", "info");
      return;
    }
    startDMWith(otherUserId);
    closeOnMobile();
  };

  const onHeaderKey = (
    e: KeyboardEvent<HTMLDivElement>,
    toggle: () => void
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <>
      <AddChannelModal isOpen={showModal} onClose={() => setShowModal(false)} />
      {activeServer && (
        <ServerSettingsModal
          isOpen={serverSettingsOpen}
          onClose={() => setServerSettingsOpen(false)}
          server={activeServer}
        />
      )}

      <div className="panel-surface h-full flex items-stretch overflow-hidden">
        <ServerRail sidebarOpen={open} onToggleSidebar={onToggleSidebar} />

        {open && <div className="w-px shrink-0 bg-[var(--border-subtle)]" />}

        <aside
          className="h-full flex flex-col justify-start overflow-hidden transition-[width,padding] duration-300 ease-in-out"
          style={{
            width: open ? sidebarWidth : 0,
            padding: open ? 30 : 0,
          }}
          aria-hidden={!open}
        >
          {open && (
            <>
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2 min-w-0">
                  <Image
                    src="/Logo.svg"
                    alt="Server"
                    width={48}
                    height={48}
                  />
                  <h2 className="text-xl font-bold truncate text-[var(--foreground)]">
                    {activeServer?.name || "Kein Server"}
                  </h2>
                </div>

                {!user?.isGuest && activeServer && (
                  <button
                    className="btn-icon w-8 h-8"
                    aria-label="Server-Einstellungen"
                    onClick={() => setServerSettingsOpen(true)}
                  >
                    <Pencil size={18} />
                  </button>
                )}
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => setChannelsOpen((v) => !v)}
                onKeyDown={(e) =>
                  onHeaderKey(e, () => setChannelsOpen((v) => !v))
                }
                className="w-full flex items-center justify-between mb-2 cursor-pointer select-none text-[var(--foreground)]"
                aria-expanded={channelsOpen}
                aria-controls="sidebar-channels"
              >
                <div className="flex items-center gap-2">
                  <ChevronDown
                    size={18}
                    className={`transition-transform text-[var(--foreground-secondary)] ${
                      channelsOpen ? "rotate-0" : "-rotate-90"
                    }`}
                  />
                  <Hash size={18} className="text-[var(--foreground-secondary)]" />
                  <span className="font-bold text-[16px]">Channels</span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowModal(true)}
                  className="btn-icon w-7 h-7"
                  aria-label="Channel hinzufügen"
                >
                  <Plus size={18} />
                </button>
              </div>

              <ul
                id="sidebar-channels"
                className={`space-y-2 mb-6 transition-[max-height,opacity] duration-300 ease-in-out ${
                  channelsOpen ? "opacity-100" : "opacity-0"
                }`}
                style={{
                  maxHeight: channelsOpen ? 500 : 0,
                  overflow: "hidden",
                }}
              >
                {channels.map((c) => {
                  const unreadMentions = unreadMentionsByChannel[c.id] || 0;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => handleSelectChannel(c.id)}
                        className={`w-full flex items-center justify-between gap-2 text-left px-3 py-2 rounded-full text-sm cursor-pointer outline-none transition ${
                          c.id === activeChannelId
                            ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] font-semibold"
                            : "text-[var(--foreground)] hover:bg-[var(--border-subtle)]"
                        }`}
                      >
                        <span className="truncate">#{c.name}</span>
                        {unreadMentions > 0 && (
                          <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--accent)] text-white text-[11px] leading-[18px] text-center">
                            {unreadMentions}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}

                <li>
                  <button
                    type="button"
                    className="text-[var(--foreground)] text-sm px-1 flex items-center gap-2 cursor-pointer hover:underline"
                    onClick={() => setShowModal(true)}
                  >
                    <Plus size={16} className="text-[var(--foreground-secondary)]" />
                    Channel hinzufügen
                  </button>
                </li>
              </ul>

              {/* FREUNDE (nur für echte Nutzer sichtbar) */}
              {!user?.isGuest && friends.length > 0 && (
                <>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setFriendsOpen((v) => !v)}
                    onKeyDown={(e) => onHeaderKey(e, () => setFriendsOpen((v) => !v))}
                    className="w-full flex items-center gap-2 mb-2 cursor-pointer select-none text-[var(--foreground)]"
                    aria-expanded={friendsOpen}
                    aria-controls="sidebar-friends"
                  >
                    <ChevronDown
                      size={18}
                      className={`transition-transform text-[var(--foreground-secondary)] ${
                        friendsOpen ? "rotate-0" : "-rotate-90"
                      }`}
                    />
                    <Users size={18} className="text-[var(--foreground-secondary)]" />
                    <span className="font-bold text-[16px]">Freunde</span>
                  </div>

                  <ul
                    id="sidebar-friends"
                    className={`space-y-2 mb-6 transition-[max-height,opacity] duration-300 ease-in-out ${
                      friendsOpen ? "opacity-100" : "opacity-0"
                    }`}
                    style={{
                      maxHeight: friendsOpen ? 500 : 0,
                      overflow: "hidden",
                    }}
                  >
                    {friends.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() => handleOpenDM(f.id)}
                          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left cursor-pointer transition hover:bg-[var(--border-subtle)] text-[var(--foreground)]"
                        >
                          <div className="relative shrink-0">
                            <Image
                              src={f.avatar || "/avatar1.png"}
                              alt={f.name}
                              width={24}
                              height={24}
                              className="rounded-full"
                            />
                            {onlineUids[f.id] && (
                              <span
                                className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--success)] ring-2 ring-[var(--surface-elevated)]"
                                aria-label="Online"
                              />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="truncate">{f.name}</div>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {/* DIRECT MESSAGES (nur für echte Nutzer sichtbar) */}
              {!user?.isGuest && (
                <>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setDmsOpen((v) => !v)}
                    onKeyDown={(e) =>
                      onHeaderKey(e, () => setDmsOpen((v) => !v))
                    }
                    className="w-full flex items-center gap-2 mb-2 cursor-pointer select-none text-[var(--foreground)]"
                    aria-expanded={dmsOpen}
                    aria-controls="sidebar-dms"
                  >
                    <ChevronDown
                      size={18}
                      className={`transition-transform text-[var(--foreground-secondary)] ${
                        dmsOpen ? "rotate-0" : "-rotate-90"
                      }`}
                    />
                    <User size={18} className="text-[var(--foreground-secondary)]" />
                    <span className="font-bold text-[16px] flex-1">
                      Direktnachrichten
                    </span>
                    <div onClick={(e) => e.stopPropagation()}>
                      <UserSearch />
                    </div>
                  </div>

                  <ul
                    id="sidebar-dms"
                    className={`space-y-2 transition-[max-height,opacity] duration-300 ease-in-out ${
                      dmsOpen ? "opacity-100" : "opacity-0"
                    }`}
                    style={{
                      maxHeight: dmsOpen ? 500 : 0,
                      overflow: "hidden",
                    }}
                  >
                    {dmThreads.map((t) => {
                      const active = activeDMUserId === t.otherUserId;
                      const unread = unreadCounts[t.otherUserId] || 0;

                      return (
                        <li key={t.convId}>
                          <button
                            type="button"
                            onClick={() => handleOpenDM(t.otherUserId)}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left cursor-pointer transition ${
                              active
                                ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]"
                                : "hover:bg-[var(--border-subtle)] text-[var(--foreground)]"
                            }`}
                            title={t.otherName}
                          >
                            <div className="relative shrink-0">
                              <Image
                                src={t.otherAvatar || "/avatar1.png"}
                                alt={t.otherName}
                                width={24}
                                height={24}
                                className="rounded-full"
                              />
                              {onlineUids[t.otherUserId] && (
                                <span
                                  className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--success)] ring-2 ring-[var(--surface-elevated)]"
                                  aria-label="Online"
                                />
                              )}
                              {unread > 0 && (
                                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--accent)] text-white text-[11px] leading-[18px] text-center">
                                  {unread}
                                </span>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="truncate">{t.otherName}</div>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </aside>

        {open && (
          <div
            onMouseDown={handleResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label="Breite der Kanalliste anpassen"
            className="hidden lg:block w-1.5 shrink-0 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--accent)_30%,transparent)] transition-colors"
          />
        )}
      </div>
    </>
  );
}
