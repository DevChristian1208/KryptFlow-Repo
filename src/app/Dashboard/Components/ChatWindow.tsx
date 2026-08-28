"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useChannel } from "@/app/Context/ChannelContext";
import { useDirect } from "@/app/Context/DirectContext";
import { useUser } from "@/app/Context/UserContext";
import { useToast } from "@/app/Context/ToastContext";
import { usePresence } from "@/app/Context/PresenceContext";
import { useNotifications } from "@/app/Context/NotificationContext";
import { useProfileDialog } from "@/app/Context/ProfileDialogContext";
import MembersModal from "./MembersModal";
import MessageList from "./MessageList";
import MessageComposer from "./MessageComposer";
import { Lock, Hash } from "lucide-react";

function EncryptionBadge({ detail }: { detail: string }) {
  return (
    <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)] text-xs font-medium">
      <Lock size={12} />
      {detail}
    </div>
  );
}

function PresenceDot({ online }: { online: boolean }) {
  if (!online) return null;
  return (
    <span
      className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[var(--success)] ring-2 ring-[var(--surface-elevated)]"
      aria-label="Online"
    />
  );
}

export default function ChatWindow() {
  const {
    activeChannel,
    channelMembers: members,
    messages: channelMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    subscribeThread,
    sendThreadReply,
    deleteThreadReply,
    reactionsByMessage: channelReactions,
    threadCountByMessage: channelThreadCounts,
    threadMessagesByParent: channelThreadMessages,
  } = useChannel();

  const {
    activeDMUser,
    activeDMUserId,
    dmMessages,
    sendDirectMessage,
    editDirectMessage,
    deleteDirectMessage,
    toggleDirectReaction,
    subscribeDirectThread,
    sendDirectThreadReply,
    deleteDirectThreadReply,
    reactionsByMessage: dmReactions,
    threadCountByMessage: dmThreadCounts,
    threadMessagesByParent: dmThreadMessages,
    startDMWith,
    isBlocked,
  } = useDirect();

  const { user: me } = useUser();
  const { openProfile } = useProfileDialog();
  const { showToast } = useToast();
  const { onlineUids } = usePresence();
  const { unreadMentionsByChannel, markChannelMentionsRead } = useNotifications();

  const [membersOpen, setMembersOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingForceScrollRef = useRef(false);

  // Erwähnungs-Badges für den geöffneten Channel als gelesen markieren
  useEffect(() => {
    if (activeChannel?.id && unreadMentionsByChannel[activeChannel.id]) {
      markChannelMentionsRead(activeChannel.id);
    }
  }, [activeChannel?.id, unreadMentionsByChannel, markChannelMentionsRead]);

  /* AVATARS */
  const topAvatars = useMemo(() => members.slice(0, 4), [members]);

  // Automatisch ans Ende scrollen, wenn eine neue Nachricht eintrifft (aber
  // nur, wenn man ohnehin schon nah am unteren Ende ist — so wird man beim
  // Lesen älterer Nachrichten nicht ungefragt nach unten gerissen). Beim
  // Wechsel der Konversation dagegen immer sofort ans Ende springen.
  function scrollToBottom(force: boolean) {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (force || distanceFromBottom < 150) {
      el.scrollTop = el.scrollHeight;
    }
  }

  useEffect(() => {
    // Der Konversationswechsel selbst leert die Liste synchron (Länge kurz
    // 0) — die entschlüsselten Nachrichten füllen sie erst asynchron danach.
    // Ein sofortiger scrollToBottom(true) träfe daher auf eine leere Liste
    // und liefe ins Leere; stattdessen einmalig vormerken und beim
    // nächsten tatsächlichen Anwachsen der Liste erzwingen.
    pendingForceScrollRef.current = true;
    scrollToBottom(true);
  }, [activeDMUserId, activeChannel?.id]);

  useEffect(() => {
    const force = pendingForceScrollRef.current;
    pendingForceScrollRef.current = false;
    scrollToBottom(force);
  }, [dmMessages.length, channelMessages.length]);

  /* -------------------------------------------------------
   * DIRECT MESSAGES VIEW
   * ----------------------------------------------------- */
  if (activeDMUserId && activeDMUser) {
    return (
      <div className="panel-surface flex-1 min-h-0 h-full flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => openProfile(activeDMUserId)}
            className="flex items-center gap-3 min-w-0 text-left hover:opacity-80 transition"
          >
            <div className="relative shrink-0">
              <Image
                src={activeDMUser.avatar || "/avatar1.png"}
                alt={activeDMUser.name}
                width={32}
                height={32}
                className="rounded-full"
              />
              <PresenceDot online={!!onlineUids[activeDMUserId]} />
            </div>
            <div className="min-w-0">
              <div className="text-base sm:text-lg md:text-xl font-bold leading-tight text-[var(--foreground)] truncate">
                {activeDMUser.name}
              </div>
              {activeDMUser.email && (
                <div className="text-[11px] sm:text-xs text-[var(--foreground-secondary)] truncate">
                  {activeDMUser.email}
                </div>
              )}
            </div>
          </button>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-2 sm:px-4 md:px-6 py-3 md:py-4"
        >
          <div className="mx-auto w-full max-w-3xl">
            <div className="flex flex-col items-center text-center pb-6 mb-4 border-b border-[var(--border-subtle)]">
              <button type="button" onClick={() => openProfile(activeDMUserId)}>
                <Image
                  src={activeDMUser.avatar || "/avatar1.png"}
                  alt={activeDMUser.name}
                  width={64}
                  height={64}
                  className="rounded-full mb-3 hover:opacity-80 transition"
                />
              </button>
              <h2 className="text-xl sm:text-2xl font-bold text-[var(--foreground)]">
                {activeDMUser.name}
              </h2>
              <p className="text-sm text-[var(--foreground-secondary)] mt-1 max-w-md">
                Das ist der Anfang deiner Unterhaltung mit {activeDMUser.name}.
              </p>
              <EncryptionBadge detail="Ende-zu-Ende-verschlüsselt · AES-256-GCM · Perfect Forward Secrecy (Pro-Nachricht-Ratchet)" />
            </div>

            <MessageList
              key={`dm-${activeDMUserId}`}
              messages={dmMessages}
              reactionsByMessage={dmReactions}
              threadCountByMessage={dmThreadCounts}
              threadMessagesByParent={dmThreadMessages}
              members={[activeDMUser]}
              onToggleReaction={toggleDirectReaction}
              onEditMessage={editDirectMessage}
              onDeleteMessage={deleteDirectMessage}
              onSubscribeThread={subscribeDirectThread}
              onSendThreadReply={sendDirectThreadReply}
              onDeleteThreadReply={deleteDirectThreadReply}
            />
          </div>
        </div>

        <div className="px-2 sm:px-4 md:px-6 pb-4 sm:pb-5 pt-2 border-t border-[var(--border-subtle)]">
          <div className="mx-auto w-full max-w-3xl">
            {isBlocked(activeDMUserId) ? (
              <p className="text-sm text-[var(--foreground-secondary)] text-center py-2">
                Du hast {activeDMUser.name} blockiert. Entblocke die Person, um wieder
                Nachrichten zu senden.
              </p>
            ) : (
              <MessageComposer
                placeholder={`Nachricht an ${activeDMUser.name}`}
                members={[activeDMUser]}
                onSend={async (text) => await sendDirectMessage(text)}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------
   * CHANNEL CHAT VIEW
   * ----------------------------------------------------- */
  if (activeChannel) {
    return (
      <>
        <div className="panel-surface flex-1 min-h-0 h-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 sm:gap-3">
              <span className="text-lg sm:text-xl md:text-2xl font-extrabold leading-tight text-[var(--foreground)]">
                # {activeChannel.name}
              </span>
              {activeChannel.description ? (
                <span className="hidden xs:inline text-[11px] sm:text-xs md:text-sm text-[var(--foreground-secondary)]">
                  – {activeChannel.description}
                </span>
              ) : null}
            </div>

            <button
              onClick={() => setMembersOpen(true)}
              className="hidden md:flex items-center gap-2 bg-[var(--border-subtle)] hover:bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)] transition px-3 py-2 rounded-full"
              aria-label="Mitglieder anzeigen"
            >
              <div className="flex -space-x-2">
                {topAvatars.map((m) => (
                  <div key={m.id} className="relative">
                    <Image
                      src={m.avatar || "/avatar1.png"}
                      alt={m.name}
                      width={24}
                      height={24}
                      className="rounded-full border-2 border-[var(--surface-elevated)]"
                    />
                    <PresenceDot online={!!onlineUids[m.id]} />
                  </div>
                ))}
              </div>
              <span className="text-xs md:text-sm text-[var(--foreground)]">
                {members.length} Mitglieder
              </span>
            </button>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto px-2 sm:px-4 md:px-6 py-3 md:py-4"
          >
            <div className="mx-auto w-full max-w-3xl">
              <div className="flex flex-col items-center text-center pb-6 mb-4 border-b border-[var(--border-subtle)]">
                <div className="w-16 h-16 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] flex items-center justify-center mb-3">
                  <Hash size={28} className="text-[var(--foreground-secondary)]" />
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-[var(--foreground)]">
                  #{activeChannel.name}
                </h2>
                <p className="text-sm text-[var(--foreground-secondary)] mt-1 max-w-md">
                  Willkommen! Das ist der Anfang von #{activeChannel.name}.
                </p>
                <EncryptionBadge detail="Ende-zu-Ende-verschlüsselt · AES-256-GCM · Perioden-Rekeying alle 24h" />
              </div>

              <MessageList
                key={`channel-${activeChannel.id}`}
                messages={channelMessages}
                reactionsByMessage={channelReactions}
                threadCountByMessage={channelThreadCounts}
                threadMessagesByParent={channelThreadMessages}
                members={members}
                onToggleReaction={toggleReaction}
                onEditMessage={editMessage}
                onDeleteMessage={deleteMessage}
                onSubscribeThread={subscribeThread}
                onSendThreadReply={sendThreadReply}
                onDeleteThreadReply={deleteThreadReply}
              />
            </div>
          </div>

          <div className="px-2 sm:px-4 md:px-6 pb-4 sm:pb-5 pt-2 border-t border-[var(--border-subtle)]">
            <div className="mx-auto w-full max-w-3xl">
              <MessageComposer
                placeholder={`Nachricht an #${activeChannel.name}`}
                members={members}
                onSend={async (text, mentionedUids) =>
                  await sendMessage(text, mentionedUids)
                }
              />
            </div>
          </div>
        </div>

        <MembersModal
          isOpen={membersOpen}
          onClose={() => setMembersOpen(false)}
          channelId={activeChannel.id}
          members={members}
          channelName={activeChannel.name}
          onStartDM={(userId) => {
            if (me?.isGuest) {
              showToast(
                "Direktnachrichten sind nur für registrierte Nutzer verfügbar. Bitte registriere dich.",
                "info"
              );
              return;
            }
            startDMWith(userId);
            setMembersOpen(false);
          }}
        />
      </>
    );
  }

  /* -------------------------------------------------------
   * FALLBACK SCREEN
   * ----------------------------------------------------- */
  return (
    <div className="panel-surface flex-1 h-full p-8 sm:p-10 flex items-center justify-center text-center overflow-hidden">
      <div>
        <Image
          src="/Logo.svg"
          alt="Cryptflow Logo"
          width={90}
          height={90}
          className="mx-auto mb-5 sm:mb-6"
        />
        <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-[var(--foreground)] leading-tight">
          Willkommen bei <span className="text-[var(--accent)]">Cryptflow</span>!
        </h1>
        <p className="text-[var(--foreground-secondary)] mt-2 sm:mt-3 text-sm sm:text-base">
          Wähle links einen Channel oder starte einen Direktchat.
        </p>
      </div>
    </div>
  );
}
