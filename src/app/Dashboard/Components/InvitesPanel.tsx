"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useNotifications } from "@/app/Context/NotificationContext";
import { useToast } from "@/app/Context/ToastContext";
import { Bell, Hash, Server, UserPlus, Check, X } from "lucide-react";

export default function InvitesPanel() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { showToast } = useToast();
  const {
    channelInvites,
    acceptChannelInvite,
    declineChannelInvite,
    serverDirectInvites,
    acceptServerDirectInvite,
    declineServerDirectInvite,
    friendRequests,
    acceptFriendRequest,
    declineFriendRequest,
  } = useNotifications();

  const total = channelInvites.length + serverDirectInvites.length + friendRequests.length;

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!open) return;
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-icon w-9 h-9 text-[var(--foreground-secondary)] relative"
        aria-label="Benachrichtigungen"
      >
        <Bell size={18} />
        {total > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-[var(--accent)] text-white text-[10px] leading-[16px] text-center">
            {total}
          </span>
        )}
      </button>

      {open && (
        <div className="card-surface absolute right-0 top-11 z-50 w-80 max-h-96 overflow-y-auto p-3">
          {total === 0 && (
            <p className="text-sm text-[var(--foreground-secondary)] px-2 py-3 text-center">
              Keine offenen Benachrichtigungen.
            </p>
          )}

          {channelInvites.map((invite) => (
            <div
              key={invite.channelId}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--border-subtle)]"
            >
              <div className="w-8 h-8 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                <Hash size={14} className="text-[var(--foreground-secondary)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-[var(--foreground)] truncate">
                  <span className="font-medium">{invite.byName}</span> lädt dich zu{" "}
                  <span className="font-medium">#{invite.channelName}</span> ein
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await acceptChannelInvite(invite);
                    showToast(`#${invite.channelName} beigetreten.`, "success");
                  } catch {
                    showToast("Annehmen fehlgeschlagen.", "error");
                  }
                }}
                className="btn-icon w-7 h-7 text-[var(--success)]"
                aria-label="Annehmen"
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                onClick={() => declineChannelInvite(invite.channelId)}
                className="btn-icon w-7 h-7 text-[var(--danger)]"
                aria-label="Ablehnen"
              >
                <X size={16} />
              </button>
            </div>
          ))}

          {serverDirectInvites.map((invite) => (
            <div
              key={invite.serverId}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--border-subtle)]"
            >
              <div className="w-8 h-8 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                <Server size={14} className="text-[var(--foreground-secondary)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-[var(--foreground)] truncate">
                  <span className="font-medium">{invite.byName}</span> lädt dich zum
                  Server <span className="font-medium">{invite.serverName}</span> ein
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await acceptServerDirectInvite(invite);
                    showToast(`${invite.serverName} beigetreten.`, "success");
                  } catch {
                    showToast("Annehmen fehlgeschlagen.", "error");
                  }
                }}
                className="btn-icon w-7 h-7 text-[var(--success)]"
                aria-label="Annehmen"
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                onClick={() => declineServerDirectInvite(invite.serverId)}
                className="btn-icon w-7 h-7 text-[var(--danger)]"
                aria-label="Ablehnen"
              >
                <X size={16} />
              </button>
            </div>
          ))}

          {friendRequests.map((req) => (
            <div
              key={req.fromUid}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--border-subtle)]"
            >
              <div className="relative shrink-0">
                <Image
                  src={req.fromAvatar || "/avatar1.png"}
                  alt={req.fromName}
                  width={32}
                  height={32}
                  className="rounded-full"
                />
                <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] flex items-center justify-center">
                  <UserPlus size={9} className="text-[var(--foreground-secondary)]" />
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-[var(--foreground)] truncate">
                  <span className="font-medium">{req.fromName}</span> möchte
                  Freund werden
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await acceptFriendRequest(req);
                    showToast(`Mit ${req.fromName} befreundet.`, "success");
                  } catch {
                    showToast("Annehmen fehlgeschlagen.", "error");
                  }
                }}
                className="btn-icon w-7 h-7 text-[var(--success)]"
                aria-label="Annehmen"
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                onClick={() => declineFriendRequest(req.fromUid)}
                className="btn-icon w-7 h-7 text-[var(--danger)]"
                aria-label="Ablehnen"
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
