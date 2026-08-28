"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  Pencil,
  Trash2,
  MessageSquare,
  SmilePlus,
  Check,
  X,
  Hash,
  Server as ServerIcon,
} from "lucide-react";
import { useUser } from "@/app/Context/UserContext";
import { useToast } from "@/app/Context/ToastContext";
import { useNotifications } from "@/app/Context/NotificationContext";
import { useProfileDialog } from "@/app/Context/ProfileDialogContext";
import type { Message, ReactionGroup, Member } from "@/app/Context/ChannelContext";
import EmojiPicker from "./EmojiPicker";
import MessageComposer from "./MessageComposer";

/** Einladungskarte für Channel-/Server-Einladungen, die als Systemnachricht
 * im DM-Chat stehen (zusätzlich zur Glocken-Benachrichtigung). Zeigt
 * Annehmen/Ablehnen, solange die zugehörige Einladung noch offen ist. */
function InviteCard({ m }: { m: Message }) {
  const { showToast } = useToast();
  const {
    channelInvites,
    acceptChannelInvite,
    declineChannelInvite,
    serverDirectInvites,
    acceptServerDirectInvite,
    declineServerDirectInvite,
  } = useNotifications();

  if (!m.invite) return null;
  const isChannel = m.kind === "channelInvite";
  const label = isChannel
    ? `#${m.invite.channelName}`
    : m.invite.serverName || "";

  const pendingChannel = isChannel
    ? channelInvites.find((i) => i.channelId === m.invite!.channelId)
    : undefined;
  const pendingServer = !isChannel
    ? serverDirectInvites.find((i) => i.serverId === m.invite!.serverId)
    : undefined;
  const isPending = isChannel ? !!pendingChannel : !!pendingServer;

  async function handleAccept() {
    try {
      if (isChannel && pendingChannel) await acceptChannelInvite(pendingChannel);
      else if (!isChannel && pendingServer) await acceptServerDirectInvite(pendingServer);
      showToast(`${label} beigetreten.`, "success");
    } catch {
      showToast("Annehmen fehlgeschlagen.", "error");
    }
  }

  function handleDecline() {
    if (isChannel) declineChannelInvite(m.invite!.channelId!);
    else declineServerDirectInvite(m.invite!.serverId!);
  }

  return (
    <div className="max-w-[75%] card-surface px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
          {isChannel ? (
            <Hash size={14} className="text-[var(--foreground-secondary)]" />
          ) : (
            <ServerIcon size={14} className="text-[var(--foreground-secondary)]" />
          )}
        </div>
        <p className="text-sm text-[var(--foreground)]">
          <span className="font-medium">{m.invite.byName}</span> lädt dich
          {isChannel ? " zu " : " zum Server "}
          <span className="font-medium">{label}</span> ein
        </p>
      </div>

      {isPending ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleAccept}
            className="btn-primary text-xs px-3 py-1.5"
          >
            Annehmen
          </button>
          <button
            type="button"
            onClick={handleDecline}
            className="btn-secondary text-xs px-3 py-1.5"
          >
            Ablehnen
          </button>
        </div>
      ) : (
        <p className="text-xs text-[var(--foreground-secondary)]">
          Bereits bearbeitet.
        </p>
      )}
    </div>
  );
}

function ClickableAvatar({
  uid,
  src,
  alt,
  size,
  className,
  onOpenProfile,
}: {
  uid?: string;
  src: string;
  alt: string;
  size: number;
  className?: string;
  onOpenProfile: (uid: string) => void;
}) {
  if (!uid) {
    return (
      <Image src={src} alt={alt} width={size} height={size} className={className} />
    );
  }
  return (
    <button type="button" onClick={() => onOpenProfile(uid)} className="shrink-0">
      <Image
        src={src}
        alt={alt}
        width={size}
        height={size}
        className={`${className || ""} hover:opacity-80 transition`}
      />
    </button>
  );
}

function isOwn(m: Message, myId?: string | null, myEmail?: string | null) {
  if (m.senderUid && myId) return m.senderUid === myId;
  return !!myEmail && m.user.email === myEmail;
}

/** Hebt `@EigenerName`-Vorkommen im Nachrichtentext farblich hervor. */
function highlightMentions(text: string, myName?: string): ReactNode {
  if (!myName?.trim()) return text;
  const escaped = myName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "gi");
  const matches = text.match(re);
  if (!matches) return text;

  const parts = text.split(re);
  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part) nodes.push(part);
    if (matches[i] !== undefined) {
      nodes.push(
        <span
          key={i}
          className="px-1 rounded bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-[var(--accent)] font-medium"
        >
          {matches[i]}
        </span>
      );
    }
  });
  return nodes;
}

type ParsedAttachment =
  | { kind: "image"; url: string; name: string }
  | { kind: "file"; url: string; name: string };

function parseAttachment(text: string): ParsedAttachment | null {
  if (!text.startsWith("ATTACH::")) return null;
  const parts = text.split("::");
  if (parts.length < 3) return null;
  const kind = parts[1] === "image" ? "image" : "file";
  const url = parts[2];
  if (!/^https?:\/\//i.test(url)) return null;
  const name = parts[3]
    ? decodeURIComponent(parts[3])
    : kind === "image"
    ? "Bild"
    : "Datei";
  return { kind, url, name };
}

function formatTime(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type MessageListProps = {
  messages: Message[];
  reactionsByMessage: Record<string, ReactionGroup[]>;
  threadCountByMessage: Record<string, number>;
  threadMessagesByParent: Record<string, Message[]>;
  members?: Member[];
  onToggleReaction: (messageId: string, emoji: string) => Promise<void>;
  onEditMessage: (messageId: string, newText: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onSubscribeThread: (parentMessageId: string) => () => void;
  onSendThreadReply: (
    parentMessageId: string,
    text: string,
    mentionedUids?: string[]
  ) => Promise<void>;
  onDeleteThreadReply: (parentMessageId: string, replyId: string) => Promise<void>;
};

export default function MessageList({
  messages,
  reactionsByMessage,
  threadCountByMessage,
  threadMessagesByParent,
  members,
  onToggleReaction,
  onEditMessage,
  onDeleteMessage,
  onSubscribeThread,
  onSendThreadReply,
  onDeleteThreadReply,
}: MessageListProps) {
  const { user: me } = useUser();
  const { openProfile } = useProfileDialog();
  const { showToast } = useToast();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reactionPickerId, setReactionPickerId] = useState<string | null>(null);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

  const pickerRef = useRef<HTMLDivElement | null>(null);
  const threadUnsubs = useRef<Record<string, () => void>>({});

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!reactionPickerId) return;
      if (pickerRef.current?.contains(e.target as Node)) return;
      setReactionPickerId(null);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [reactionPickerId]);

  useEffect(() => {
    const unsubs = threadUnsubs.current;
    return () => {
      Object.values(unsubs).forEach((fn) => fn());
    };
  }, []);

  function toggleThread(messageId: string) {
    // Subscribe/Unsubscribe bewusst AUSSERHALB des setState-Updaters, da
    // React (StrictMode) Updater-Funktionen doppelt aufrufen kann — würde
    // der Firebase-Listener dort registriert, leakt die erste Instanz.
    if (expandedThreads.has(messageId)) {
      threadUnsubs.current[messageId]?.();
      delete threadUnsubs.current[messageId];
      setExpandedThreads((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    } else {
      threadUnsubs.current[messageId] = onSubscribeThread(messageId);
      setExpandedThreads((prev) => new Set(prev).add(messageId));
    }
  }

  function startEdit(m: Message) {
    setEditingId(m.id);
    setEditValue(m.text);
  }

  async function saveEdit(messageId: string) {
    const text = editValue.trim();
    if (!text) {
      setEditingId(null);
      return;
    }
    try {
      await onEditMessage(messageId, text);
      setEditingId(null);
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Bearbeiten fehlgeschlagen.",
        "error"
      );
    }
  }

  async function confirmDelete(messageId: string, parentId?: string) {
    try {
      if (parentId) await onDeleteThreadReply(parentId, messageId);
      else await onDeleteMessage(messageId);
      setDeletingId(null);
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Löschen fehlgeschlagen.",
        "error"
      );
    }
  }

  function renderBubble(
    m: Message,
    mine: boolean,
    compact: boolean,
    parentId?: string
  ) {
    if (m.kind) return <InviteCard m={m} />;

    const att = parseAttachment(m.text);
    const editable = mine && !att && !m.deleted && editingId !== m.id;
    const deletable = mine && !m.deleted && deletingId !== m.id;
    const isEditing = editingId === m.id;
    const isDeleting = deletingId === m.id;

    return (
      <div className="max-w-[75%] group/bubble">
        <div
          className={`text-[12px] mb-1 ${mine ? "text-right" : ""} text-[var(--foreground-secondary)]`}
        >
          {!mine && (
            <span className="font-semibold text-[var(--foreground)]">{m.user.name}</span>
          )}{" "}
          <span className="ml-1">{formatTime(m.createdAt)}</span>
          {m.edited && <span className="ml-1 italic">(bearbeitet)</span>}
        </div>

        <div className="flex items-center gap-1">
          {mine && editable && (
            <button
              type="button"
              onClick={() => startEdit(m)}
              className="btn-icon w-7 h-7 shrink-0 opacity-0 group-hover/bubble:opacity-100 text-[var(--foreground-secondary)]"
              aria-label="Nachricht bearbeiten"
            >
              <Pencil size={14} />
            </button>
          )}
          {mine && deletable && !isEditing && (
            <button
              type="button"
              onClick={() => setDeletingId(m.id)}
              className="btn-icon w-7 h-7 shrink-0 opacity-0 group-hover/bubble:opacity-100 text-[var(--danger)]"
              aria-label="Nachricht löschen"
            >
              <Trash2 size={14} />
            </button>
          )}

          {isEditing ? (
            <div className="input-pill flex-1">
              <textarea
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    saveEdit(m.id);
                  } else if (e.key === "Escape") {
                    setEditingId(null);
                  }
                }}
                className="flex-1 resize-none outline-none bg-transparent text-[var(--foreground)] text-sm py-1"
                rows={1}
              />
              <button
                type="button"
                onClick={() => saveEdit(m.id)}
                className="btn-icon w-7 h-7 text-[var(--accent)]"
                aria-label="Speichern"
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="btn-icon w-7 h-7 text-[var(--foreground-secondary)]"
                aria-label="Abbrechen"
              >
                <X size={16} />
              </button>
            </div>
          ) : isDeleting ? (
            <div className="input-pill flex-1 items-center">
              <span className="flex-1 text-sm text-[var(--foreground)]">
                Nachricht wirklich löschen?
              </span>
              <button
                type="button"
                onClick={() => confirmDelete(m.id, parentId)}
                className="btn-icon w-7 h-7 text-[var(--danger)]"
                aria-label="Löschen bestätigen"
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                onClick={() => setDeletingId(null)}
                className="btn-icon w-7 h-7 text-[var(--foreground-secondary)]"
                aria-label="Abbrechen"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div
              className={`rounded-2xl px-4 py-2 ${
                mine
                  ? "bg-[var(--accent)] text-white rounded-br-md"
                  : "bg-[var(--border-subtle)] text-[var(--foreground)] rounded-bl-md"
              } ${m.deleted ? "italic opacity-70" : ""}`}
            >
              {att ? (
                att.kind === "image" ? (
                  <a href={att.url} target="_blank" rel="noreferrer">
                    {/* `img` beibehalten: externe URLs ohne next/image Domain-Konfig */}
                    <img
                      src={att.url}
                      alt={att.name}
                      className="rounded-lg max-h-[320px] max-w-full object-contain"
                    />
                  </a>
                ) : (
                  <a
                    href={att.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`underline ${mine ? "text-white" : "text-[var(--accent)]"}`}
                  >
                    📎 {att.name}
                  </a>
                )
              ) : (
                <p className="whitespace-pre-wrap break-words">
                  {m.deleted ? m.text : highlightMentions(m.text, me?.name)}
                </p>
              )}
            </div>
          )}
        </div>

        {!compact && !m.deleted && (
          <>
            {/* Reaktionen */}
            <div
              className={`mt-1 flex flex-wrap items-center gap-1 ${mine ? "justify-end" : ""}`}
            >
              {(reactionsByMessage[m.id] || []).map((g) => {
                const reacted = !!me?.id && g.uids.includes(me.id);
                return (
                  <button
                    key={g.emoji}
                    type="button"
                    onClick={() => onToggleReaction(m.id, g.emoji)}
                    className={`text-xs px-2 py-0.5 rounded-full border transition ${
                      reacted
                        ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
                        : "border-[var(--border-subtle)] hover:bg-[var(--border-subtle)]"
                    }`}
                  >
                    {g.emoji} {g.uids.length}
                  </button>
                );
              })}

              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setReactionPickerId((cur) => (cur === m.id ? null : m.id))
                  }
                  className="btn-icon w-6 h-6 text-[var(--foreground-secondary)]"
                  aria-label="Reagieren"
                >
                  <SmilePlus size={14} />
                </button>
                {reactionPickerId === m.id && (
                  <div ref={pickerRef} className="absolute z-50 top-7">
                    <EmojiPicker
                      onSelect={(emoji) => {
                        onToggleReaction(m.id, emoji);
                        setReactionPickerId(null);
                      }}
                    />
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => toggleThread(m.id)}
                className="text-xs px-2 py-0.5 rounded-full text-[var(--foreground-secondary)] hover:bg-[var(--border-subtle)] flex items-center gap-1"
              >
                <MessageSquare size={12} />
                {threadCountByMessage[m.id]
                  ? `${threadCountByMessage[m.id]} Antworten`
                  : "Antworten"}
              </button>
            </div>

            {expandedThreads.has(m.id) && (
              <div
                className={`mt-2 pl-3 border-l-2 border-[var(--border-subtle)] space-y-2 ${
                  mine ? "ml-auto" : ""
                }`}
              >
                {(threadMessagesByParent[m.id] || []).map((reply) => {
                  const replyMine = isOwn(reply, me?.id, me?.email);
                  return (
                    <div
                      key={reply.id}
                      className={`flex items-start gap-2 ${
                        replyMine ? "justify-end" : "justify-start"
                      }`}
                    >
                      {!replyMine && (
                        <ClickableAvatar
                          uid={reply.senderUid}
                          src={reply.user.avatar || "/avatar1.png"}
                          alt={reply.user.name}
                          size={22}
                          className="rounded-full mt-1"
                          onOpenProfile={openProfile}
                        />
                      )}
                      {renderBubble(reply, replyMine, true, m.id)}
                      {replyMine && (
                        <ClickableAvatar
                          uid={reply.senderUid}
                          src={reply.user.avatar || "/avatar1.png"}
                          alt={reply.user.name}
                          size={22}
                          className="rounded-full mt-1"
                          onOpenProfile={openProfile}
                        />
                      )}
                    </div>
                  );
                })}

                <div className="max-w-sm">
                  <MessageComposer
                    placeholder="Antworten im Thread…"
                    members={members}
                    onSend={(text, mentionedUids) =>
                      onSendThreadReply(m.id, text, mentionedUids)
                    }
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((m) => {
        const mine = isOwn(m, me?.id, me?.email);

        return (
          <div
            key={m.id}
            className={`flex items-start gap-3 ${mine ? "justify-end" : "justify-start"}`}
          >
            {!mine && (
              <ClickableAvatar
                uid={m.senderUid}
                src={m.user.avatar || "/avatar1.png"}
                alt={m.user.name}
                size={32}
                className="rounded-full mt-1"
                onOpenProfile={openProfile}
              />
            )}

            {renderBubble(m, mine, false)}

            {mine && (
              <ClickableAvatar
                uid={m.senderUid}
                src={m.user.avatar || "/avatar1.png"}
                alt={m.user.name}
                size={32}
                className="rounded-full mt-1"
                onOpenProfile={openProfile}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
