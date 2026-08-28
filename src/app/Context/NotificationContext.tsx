"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { ref, onValue, update, get } from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "./UserContext";

type MentionDb = {
  channelId: string;
  messageId: string;
  fromUid: string;
  createdAt: number;
  read: boolean;
};

export type ChannelInvite = {
  channelId: string;
  channelName: string;
  byUid: string;
  byName: string;
  createdAt: number;
};

export type ServerDirectInvite = {
  serverId: string;
  serverName: string;
  byUid: string;
  byName: string;
  createdAt: number;
};

export type FriendRequest = {
  fromUid: string;
  fromName: string;
  fromAvatar?: string;
  createdAt: number;
};

type NotificationContextType = {
  unreadMentionsByChannel: Record<string, number>;
  markChannelMentionsRead: (channelId: string) => Promise<void>;
  channelInvites: ChannelInvite[];
  acceptChannelInvite: (invite: ChannelInvite) => Promise<void>;
  declineChannelInvite: (channelId: string) => Promise<void>;
  serverDirectInvites: ServerDirectInvite[];
  acceptServerDirectInvite: (invite: ServerDirectInvite) => Promise<void>;
  declineServerDirectInvite: (serverId: string) => Promise<void>;
  friendRequests: FriendRequest[];
  acceptFriendRequest: (req: FriendRequest) => Promise<void>;
  declineFriendRequest: (fromUid: string) => Promise<void>;
};

const NotificationContext = createContext<NotificationContextType | undefined>(
  undefined
);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [unreadMentionsByChannel, setUnreadMentionsByChannel] = useState<
    Record<string, number>
  >({});
  const mentionsRef = useRef<Record<string, MentionDb>>({});
  const [channelInvites, setChannelInvites] = useState<ChannelInvite[]>([]);
  const [serverDirectInvites, setServerDirectInvites] = useState<ServerDirectInvite[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);

  useEffect(() => {
    if (!user?.id) {
      setUnreadMentionsByChannel({});
      mentionsRef.current = {};
      return;
    }

    const r = ref(db, `channelMentions/${user.id}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, MentionDb> | null) || {};
      mentionsRef.current = raw;

      const counts: Record<string, number> = {};
      for (const m of Object.values(raw)) {
        if (m.read) continue;
        counts[m.channelId] = (counts[m.channelId] || 0) + 1;
      }
      setUnreadMentionsByChannel(counts);
    });

    return () => unsub();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setChannelInvites([]);
      return;
    }
    const r = ref(db, `channelInvites/${user.id}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, ChannelInvite> | null) || {};
      setChannelInvites(
        Object.values(raw).sort((a, b) => b.createdAt - a.createdAt)
      );
    });
    return () => unsub();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setServerDirectInvites([]);
      return;
    }
    const r = ref(db, `serverDirectInvites/${user.id}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, ServerDirectInvite> | null) || {};
      setServerDirectInvites(
        Object.values(raw).sort((a, b) => b.createdAt - a.createdAt)
      );
    });
    return () => unsub();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setFriendRequests([]);
      return;
    }
    const r = ref(db, `friendRequests/${user.id}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, Omit<FriendRequest, "fromUid">> | null) || {};
      setFriendRequests(
        Object.entries(raw)
          .map(([fromUid, v]) => ({ fromUid, ...v }))
          .sort((a, b) => b.createdAt - a.createdAt)
      );
    });
    return () => unsub();
  }, [user?.id]);

  const acceptChannelInvite = useCallback(
    async (invite: ChannelInvite) => {
      if (!user?.id) return;

      // channels/.../members/{uid}s Regel verlangt (bei Selbst-Schreiben)
      // eine noch bestehende channelInvites-Einladung — das darf also nicht
      // im selben Mehrfach-Schreibvorgang gelöscht werden, in dem diese
      // Regel ausgewertet wird (das Cross-Path-Problem, das sich in dieser
      // Session schon mehrfach gezeigt hat). Erst beitreten, danach in
      // einem zweiten Aufruf die Einladung aufräumen.
      const joinUpdates: Record<string, unknown> = {
        [`channels/${invite.channelId}/members/${user.id}`]: true,
      };

      // Eine Channel-Einladung muss auch Server-Mitgliedschaft geben — sonst
      // taucht der Server (und damit der Kanal) für die eingeladene Person
      // nirgends auf, selbst nachdem sie dem Kanal beigetreten ist (die
      // Kanalliste ist nach activeServerId gefiltert, der Server erscheint
      // aber nur in der Rail, wenn man serverMembers-Mitglied ist).
      const channelSnap = await get(ref(db, `channels/${invite.channelId}/serverId`));
      const serverId = channelSnap.val() as string | null;
      if (serverId) {
        const memberSnap = await get(
          ref(db, `serverMembers/${serverId}/${user.id}`)
        );
        if (!memberSnap.exists()) {
          joinUpdates[`serverMembers/${serverId}/${user.id}`] = {
            role: "member",
            joinedAt: Date.now(),
          };
          joinUpdates[`userServers/${user.id}/${serverId}`] = true;
        }
      }

      await update(ref(db), joinUpdates);
      await update(ref(db), {
        [`channelInvites/${user.id}/${invite.channelId}`]: null,
      });
    },
    [user?.id]
  );

  const declineChannelInvite = useCallback(
    async (channelId: string) => {
      if (!user?.id) return;
      await update(ref(db), {
        [`channelInvites/${user.id}/${channelId}`]: null,
      });
    },
    [user?.id]
  );

  const acceptServerDirectInvite = useCallback(
    async (invite: ServerDirectInvite) => {
      if (!user?.id) return;
      await update(ref(db), {
        [`serverMembers/${invite.serverId}/${user.id}`]: {
          role: "member",
          joinedAt: Date.now(),
        },
        [`userServers/${user.id}/${invite.serverId}`]: true,
        [`serverDirectInvites/${user.id}/${invite.serverId}`]: null,
      });
    },
    [user?.id]
  );

  const declineServerDirectInvite = useCallback(
    async (serverId: string) => {
      if (!user?.id) return;
      await update(ref(db), {
        [`serverDirectInvites/${user.id}/${serverId}`]: null,
      });
    },
    [user?.id]
  );

  const acceptFriendRequest = useCallback(
    async (req: FriendRequest) => {
      if (!user?.id) return;
      await update(ref(db), {
        [`friends/${user.id}/${req.fromUid}`]: {
          name: req.fromName,
          avatar: req.fromAvatar || null,
          since: Date.now(),
        },
        [`friends/${req.fromUid}/${user.id}`]: {
          name: user.name || "Unbekannt",
          avatar: user.avatar || null,
          since: Date.now(),
        },
        [`friendRequests/${user.id}/${req.fromUid}`]: null,
      });
    },
    [user?.id, user?.name, user?.avatar]
  );

  const declineFriendRequest = useCallback(
    async (fromUid: string) => {
      if (!user?.id) return;
      await update(ref(db), {
        [`friendRequests/${user.id}/${fromUid}`]: null,
      });
    },
    [user?.id]
  );

  const markChannelMentionsRead = useCallback(
    async (channelId: string) => {
      if (!user?.id) return;
      const updates: Record<string, unknown> = {};
      for (const [mentionId, m] of Object.entries(mentionsRef.current)) {
        if (m.channelId === channelId && !m.read) {
          updates[`channelMentions/${user.id}/${mentionId}/read`] = true;
        }
      }
      if (Object.keys(updates).length > 0) {
        await update(ref(db), updates);
      }
    },
    [user?.id]
  );

  return (
    <NotificationContext.Provider
      value={{
        unreadMentionsByChannel,
        markChannelMentionsRead,
        channelInvites,
        acceptChannelInvite,
        declineChannelInvite,
        serverDirectInvites,
        acceptServerDirectInvite,
        declineServerDirectInvite,
        friendRequests,
        acceptFriendRequest,
        declineFriendRequest,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx)
    throw new Error("useNotifications must be used within NotificationProvider");
  return ctx;
}
