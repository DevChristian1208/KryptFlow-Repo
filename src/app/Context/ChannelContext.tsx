"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
  useCallback,
  useRef,
} from "react";
import {
  ref,
  onValue,
  off,
  push,
  set,
  get,
  update,
  runTransaction,
  onDisconnect,
} from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { db, auth } from "@/app/lib/firebase";
import { useUser } from "./UserContext";
import { useToast } from "./ToastContext";
import { useServer } from "./ServerContext";
import {
  generateChannelKey,
  wrapChannelKeyForMember,
  unwrapChannelKey,
  encryptText,
  decryptText,
  signText,
  verifyText,
  fetchPublicIdentity,
  getPublicKeyVersion,
  epochIdForTimestamp,
  type ChannelKeyEnvelope,
  type EncryptedPayload,
} from "@/app/lib/crypto";

const CHANNEL_EPOCH_DURATION_MS = 24 * 60 * 60 * 1000;

type ChannelDb = {
  name?: string;
  description?: string;
  createdAt?: number;
  createdByEmail?: string;
  public?: boolean;
  members?: Record<string, true>;
  serverId?: string;
  restricted?: boolean;
  announcementOnly?: boolean;
};

type ChannelMessageDb = {
  ciphertext?: string;
  iv?: string;
  senderUid?: string;
  signature?: string;
  createdAt?: number;
  edited?: boolean;
  editedAt?: number;
  deleted?: boolean;
  deletedAt?: number;
  epochId?: string;
  text?: string;
  user?: { name?: string; email?: string; avatar?: string };
};

type ReactionDb = EncryptedPayload & {
  signature: string;
  createdAt: number;
  epochId?: string;
};

type PollVoteDb = EncryptedPayload & {
  signature: string;
  createdAt: number;
  epochId?: string;
};

export type Channel = {
  id: string;
  name: string;
  description?: string;
  createdAt?: number;
  createdByEmail?: string;
  public?: boolean;
  members?: Record<string, true>;
  serverId?: string;
  restricted?: boolean;
  announcementOnly?: boolean;
};

export type ReactionGroup = { emoji: string; uids: string[] };

export type Profile = { name: string; email: string; avatar: string };

export type Member = { id: string; name: string; email?: string; avatar?: string };

export type Message = {
  id: string;
  text: string;
  createdAt?: number;
  user: { name: string; email: string; avatar?: string };
  senderUid?: string;
  /** false = Signatur ungültig, undefined = unverschlüsselte Alt-Nachricht ohne Signatur */
  verified?: boolean;
  edited?: boolean;
  editedAt?: number;
  deleted?: boolean;
  epochId?: string;
  kind?: "channelInvite" | "serverInvite";
  invite?: {
    channelId?: string;
    channelName?: string;
    serverId?: string;
    serverName?: string;
    byUid: string;
    byName: string;
  };
};

type ChannelContextType = {
  channels: Channel[];
  activeChannelId: string | null;
  activeChannel: Channel | null;
  channelMembers: Member[];
  messages: Message[];
  reactionsByMessage: Record<string, ReactionGroup[]>;
  pollVotesByMessage: Record<string, Record<string, number>>;
  votePoll: (messageId: string, optionIndex: number) => Promise<void>;
  threadCountByMessage: Record<string, number>;
  threadMessagesByParent: Record<string, Message[]>;
  setActiveChannelId: (id: string | null) => void;
  createChannel: (
    name: string,
    description?: string,
    restricted?: boolean,
    opts?: { serverIdOverride?: string; skipRateLimit?: boolean; announcementOnly?: boolean }
  ) => Promise<void>;
  setChannelRestricted: (channelId: string, restricted: boolean) => Promise<void>;
  setChannelAnnouncementOnly: (channelId: string, announcementOnly: boolean) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  inviteToChannel: (channelId: string, channelName: string, targetUid: string) => Promise<void>;
  sendMessage: (text: string, mentionedUids?: string[]) => Promise<void>;
  editMessage: (messageId: string, newText: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  subscribeThread: (parentMessageId: string) => () => void;
  sendThreadReply: (
    parentMessageId: string,
    text: string,
    mentionedUids?: string[]
  ) => Promise<void>;
  deleteThreadReply: (parentMessageId: string, replyId: string) => Promise<void>;
  pinnedMessageIds: Set<string>;
  pinMessage: (messageId: string) => Promise<void>;
  unpinMessage: (messageId: string) => Promise<void>;
  getMessageEditHistory: (messageId: string) => Promise<EditHistoryEntry[]>;
  typingUserIds: string[];
  notifyTyping: () => void;
  loading: boolean;
  error: string | null;
};

export type EditHistoryEntry = { id: string; text: string; editedAt: number };

type NewUserDb = {
  authUid: string;
  newname: string;
  newemail: string;
  avatar: string;
  isGuest?: boolean;
};

const ChannelContext = createContext<ChannelContextType | undefined>(undefined);

async function decodeMessage(
  id: string,
  m: ChannelMessageDb,
  resolveKey: (epochId?: string) => Promise<CryptoKey | null>,
  resolveProfile: (uid: string) => Promise<Profile>
): Promise<Message> {
  if (m.deleted) {
    const profile = m.senderUid
      ? await resolveProfile(m.senderUid)
      : { name: "Unbekannt", email: "", avatar: "/avatar1.png" };
    return {
      id,
      text: "Nachricht gelöscht",
      createdAt: m.createdAt || 0,
      user: profile,
      senderUid: m.senderUid,
      deleted: true,
    };
  }

  if (!m.ciphertext && m.text) {
    return {
      id,
      text: m.text,
      createdAt: m.createdAt || 0,
      user: {
        name: m.user?.name || "Unbekannt",
        email: m.user?.email || "",
        avatar: m.user?.avatar || "/avatar1.png",
      },
    };
  }

  if (!m.ciphertext || !m.iv || !m.senderUid) {
    return {
      id,
      text: "🔒 Nachricht kann nicht gelesen werden.",
      createdAt: m.createdAt || 0,
      user: { name: "Unbekannt", email: "" },
    };
  }

  const profile = await resolveProfile(m.senderUid);
  const channelKey = await resolveKey(m.epochId);

  if (!channelKey) {
    return {
      id,
      text: "🔒 Warte auf Verschlüsselungs-Schlüssel …",
      createdAt: m.createdAt || 0,
      user: profile,
    };
  }

  try {
    const text = await decryptText(channelKey, { ciphertext: m.ciphertext, iv: m.iv });

    let verified: boolean | undefined;
    if (m.signature) {
      const senderIdentity = await fetchPublicIdentity(m.senderUid);
      verified = senderIdentity
        ? await verifyText(senderIdentity.ecdsa, m.ciphertext, m.signature)
        : false;
    }

    return {
      id,
      text:
        verified === false
          ? `⚠️ Signatur ungültig – Nachricht könnte manipuliert sein: ${text}`
          : text,
      createdAt: m.createdAt || 0,
      user: profile,
      senderUid: m.senderUid,
      verified,
      edited: m.edited,
      editedAt: m.editedAt,
      epochId: m.epochId,
    };
  } catch {
    return {
      id,
      text: "🔒 Nachricht kann nicht entschlüsselt werden.",
      createdAt: m.createdAt || 0,
      user: profile,
    };
  }
}

function useAuthReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, () => setReady(true));
    return () => unsub();
  }, []);
  return ready;
}

export function ChannelProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const { showToast } = useToast();
  const { servers, activeServerId } = useServer();
  const authReady = useAuthReady();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [channelMembers, setChannelMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactionsByMessage, setReactionsByMessage] = useState<
    Record<string, ReactionGroup[]>
  >({});
  const [pollVotesByMessage, setPollVotesByMessage] = useState<
    Record<string, Record<string, number>>
  >({});
  const [threadCountByMessage, setThreadCountByMessage] = useState<
    Record<string, number>
  >({});
  const [threadMessagesByParent, setThreadMessagesByParent] = useState<
    Record<string, Message[]>
  >({});
  const [pinnedMessageIds, setPinnedMessageIds] = useState<Set<string>>(new Set());
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const lastTypingNotifyRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channelKeyCache = useRef(new Map<string, CryptoKey>());
  const channelEpochKeyCache = useRef(new Map<string, CryptoKey>());
  const profileCache = useRef(new Map<string, Profile>());
  const reactionUnsubs = useRef<Record<string, () => void>>({});
  const pollVoteUnsubs = useRef<Record<string, () => void>>({});
  const threadCountUnsubs = useRef<Record<string, () => void>>({});

  const resolveProfile = useCallback(
    async (uid: string): Promise<Profile> => {
      if (user && uid === user.id) {
        return {
          name: user.name,
          email: user.email,
          avatar: user.avatar || "/avatar1.png",
        };
      }
      const cached = profileCache.current.get(uid);
      if (cached) return cached;

      const snap = await get(ref(db, `newusers/${uid}`));
      const v = snap.val() as NewUserDb | null;
      const profile: Profile = v
        ? {
            name: v.newname || "Unbekannt",
            email: v.newemail || "",
            avatar: v.avatar || "/avatar1.png",
          }
        : { name: "Unbekannt", email: "", avatar: "/avatar1.png" };

      profileCache.current.set(uid, profile);
      return profile;
    },
    [user]
  );

  const getOwnChannelKey = useCallback(
    async (channelId: string): Promise<CryptoKey | null> => {
      if (!user?.id) return null;
      const cached = channelKeyCache.current.get(channelId);
      if (cached) return cached;

      const snap = await get(ref(db, `channelKeys/${channelId}/${user.id}`));
      if (!snap.exists()) return null;

      try {
        const key = await unwrapChannelKey(
          user.id,
          snap.val() as ChannelKeyEnvelope
        );
        channelKeyCache.current.set(channelId, key);
        return key;
      } catch (e) {
        // Erwartbar (kein Bug): nach einem Origin-/Geräte-Wechsel ohne
        // Schlüssel-Backup kann das eigene Gerät den eigenen alten Legacy-Key
        // nicht mehr entschlüsseln — nur ein anderes, noch gültiges
        // Mitglied kann den Envelope neu wrappen. Kein console.error, damit
        // dieser für den Nutzer nicht reparierbare Fall nicht wie ein Absturz
        // aussieht.
        console.debug("[ChannelContext] Eigener Legacy-Channel-Key nicht entschlüsselbar:", e);
        return null;
      }
    },
    [user?.id]
  );

  const getOwnChannelEpochKey = useCallback(
    async (channelId: string, epochId: string): Promise<CryptoKey | null> => {
      if (!user?.id) return null;
      const cacheKey = `${channelId}:${epochId}`;
      const cached = channelEpochKeyCache.current.get(cacheKey);
      if (cached) return cached;

      const snap = await get(
        ref(db, `channelKeyEpochs/${channelId}/${epochId}/${user.id}`)
      );
      if (!snap.exists()) return null;

      try {
        const key = await unwrapChannelKey(user.id, snap.val() as ChannelKeyEnvelope);
        channelEpochKeyCache.current.set(cacheKey, key);
        return key;
      } catch (e) {
        console.debug("[ChannelContext] Eigener Epochen-Key nicht entschlüsselbar:", e);
        return null;
      }
    },
    [user?.id]
  );

  // Per Firebase-Transaction atomar "beansprucht", damit zwei gleichzeitig
  // aktive Clients nicht mit unterschiedlichen Schlüsseln für dieselbe
  // Epoche kollidieren.
  const claimChannelEpoch = useCallback(
    async (channelId: string, epochId: string, memberUids: string[]) => {
      const nodeRef = ref(db, `channelKeyEpochs/${channelId}/${epochId}`);
      const existing = await get(nodeRef);
      if (existing.exists()) return;

      const channelKey = await generateChannelKey();
      const envelopes: Record<string, ChannelKeyEnvelope> = {};
      for (const uid of memberUids) {
        // bypassCache: das Anlegen einer Epoche passiert selten — die
        // minimale Extra-Latenz hier ist es wert, damit ein bis zu 60s alter
        // zwischengespeicherter Public Key niemals dazu führt, dass ein
        // Envelope für ein gerade erst (neu) veröffentlichtes Mitglied gegen
        // den falschen Schlüssel gewrappt wird und damit für immer
        // unentschlüsselbar bliebe.
        const envelope = await wrapChannelKeyForMember(channelKey, uid, {
          bypassCache: true,
        });
        if (envelope) envelopes[uid] = envelope;
      }
      if (Object.keys(envelopes).length === 0) return;

      await runTransaction(nodeRef, (current) => {
        if (current !== null) return; // jemand anderes war schneller -> abbrechen
        return envelopes;
      });
    },
    []
  );

  const ensureUserInAllChannels = useCallback(async () => {
    if (!user?.id || servers.length === 0) return;

    try {
      const myServerIds = new Set(servers.map((s) => s.id));
      const chansSnap = await get(ref(db, "channels"));
      const chans = (chansSnap.val() || {}) as Record<string, ChannelDb>;
      const relevantEntries = Object.entries(chans).filter(
        ([, chan]) => chan.serverId && myServerIds.has(chan.serverId)
      );

      const neededServerIds = Array.from(
        new Set(
          relevantEntries
            .filter(([, chan]) => !chan.restricted)
            .map(([, chan]) => chan.serverId!)
        )
      );
      const serverMembersCache = new Map<string, string[]>();
      await Promise.all(
        neededServerIds.map(async (sid) => {
          const smSnap = await get(ref(db, `serverMembers/${sid}`));
          serverMembersCache.set(
            sid,
            Object.keys((smSnap.val() as Record<string, unknown>) || {})
          );
        })
      );

      // Mitgliedschaft selbst wird hier bewusst NICHT vergeben (läuft über
      // channelInvites bzw. Server-Mitgliedschaft, siehe Rules) — diese
      // Funktion liefert nur fehlende Schlüssel-Envelopes nach. Alle Kanäle
      // laufen parallel statt nacheinander, damit ein gerade beigetretenes
      // Mitglied nicht durch sequenzielle Roundtrips ins Leere läuft (siehe
      // getCurrentChannelEpochKey).
      await Promise.all(
        relevantEntries.map(async ([cid, chan]) => {
          let memberUids: string[];
          if (chan.restricted) {
            if (!chan.members?.[user.id]) return;
            memberUids = Object.keys({ ...(chan.members || {}), [user.id]: true });
          } else {
            memberUids = serverMembersCache.get(chan.serverId!) || [];
          }

          const channelKey = await getOwnChannelKey(cid);
          if (channelKey) {
            const keysSnap = await get(ref(db, `channelKeys/${cid}`));
            const existingKeys =
              (keysSnap.val() as Record<string, ChannelKeyEnvelope> | null) || {};
            await Promise.all(
              memberUids.map(async (uid) => {
                const existing = existingKeys[uid];
                // Auch "gehört zu einem inzwischen ersetzten Schlüsselpaar"
                // nachliefern, nicht nur "fehlt komplett" — sonst bleibt ein
                // Mitglied nach einem Origin-/Geräte-Wechsel dauerhaft mit
                // einem für sich selbst unentschlüsselbaren Envelope stehen.
                const currentVersion = await getPublicKeyVersion(uid, {
                  bypassCache: true,
                });
                if (existing && existing.forKeyVersion === currentVersion) return;
                const envelope = await wrapChannelKeyForMember(channelKey, uid, {
                  bypassCache: true,
                });
                if (envelope) {
                  await set(ref(db, `channelKeys/${cid}/${uid}`), envelope);
                }
              })
            );
          }

          const epochsSnap = await get(ref(db, `channelKeyEpochs/${cid}`));
          const epochs =
            (epochsSnap.val() as Record<string, Record<string, ChannelKeyEnvelope>> | null) ||
            {};

          await Promise.all(
            Object.entries(epochs).map(async ([epochId, envelopes]) => {
              const myEnvelope = envelopes[user.id];
              if (!myEnvelope) return;

              let epochKey: CryptoKey;
              try {
                epochKey = await unwrapChannelKey(user.id, myEnvelope);
              } catch {
                return;
              }

              await Promise.all(
                memberUids.map(async (uid) => {
                  const existing = envelopes[uid];
                  const currentVersion = await getPublicKeyVersion(uid, {
                    bypassCache: true,
                  });
                  if (existing && existing.forKeyVersion === currentVersion) return;
                  const envelope = await wrapChannelKeyForMember(epochKey, uid, {
                    bypassCache: true,
                  });
                  if (envelope) {
                    await set(
                      ref(db, `channelKeyEpochs/${cid}/${epochId}/${uid}`),
                      envelope
                    );
                  }
                })
              );
            })
          );

          const currentEpochId = epochIdForTimestamp(CHANNEL_EPOCH_DURATION_MS);
          if (!epochs[currentEpochId]) {
            await claimChannelEpoch(cid, currentEpochId, memberUids);
          }
        })
      );
    } catch (e) {
      console.warn(
        "[ChannelContext] ensureUserInAllChannels fehlgeschlagen:",
        e
      );
    }
  }, [user?.id, servers, getOwnChannelKey, claimChannelEpoch]);

  const resolveChannelKey = useCallback(
    (channelId: string, epochId?: string): Promise<CryptoKey | null> =>
      epochId
        ? getOwnChannelEpochKey(channelId, epochId)
        : getOwnChannelKey(channelId),
    [getOwnChannelEpochKey, getOwnChannelKey]
  );

  const getCurrentChannelEpochKey = useCallback(
    async (channelId: string): Promise<{ epochId: string; key: CryptoKey } | null> => {
      const epochId = epochIdForTimestamp(CHANNEL_EPOCH_DURATION_MS);
      let key = await getOwnChannelEpochKey(channelId, epochId);
      if (!key) {
        // Gleiche Mitgliederquelle wie in ensureUserInAllChannels: bei
        // nicht-eingeschränkten Kanälen ist channels/{id}/members oft nur
        // mit dem Ersteller gefüllt, würde man hier trotzdem nur diese Liste
        // zum Umschlag-Wrappen benutzen, bekäme bei einem Epochenwechsel nur
        // der Ersteller einen gültigen Envelope.
        const chanSnap = await get(ref(db, `channels/${channelId}`));
        const chan = chanSnap.val() as ChannelDb | null;
        let memberUids: string[];
        if (chan?.restricted) {
          memberUids = Object.keys({ ...(chan.members || {}), [user!.id]: true });
        } else if (chan?.serverId) {
          const smSnap = await get(ref(db, `serverMembers/${chan.serverId}`));
          memberUids = Object.keys(
            (smSnap.val() as Record<string, unknown> | null) || {}
          );
        } else {
          memberUids = Object.keys(chan?.members || {});
        }
        await claimChannelEpoch(channelId, epochId, memberUids);
        key = await getOwnChannelEpochKey(channelId, epochId);

        // Selten, aber möglich: die Epoche existierte schon (z. B. von
        // einem anderen, gerade erst beigetretenen Mitglied angelegt),
        // enthielt aber noch keinen Umschlag für mich — claimChannelEpoch()
        // bricht dann sofort ab. Das löst sich oft binnen Sekunden von
        // selbst, sobald ein anderes, bereits eingeweihtes Mitglied gerade
        // online ist. Ein paar Mal kurz erneut nachsehen, bevor endgültig
        // aufgegeben wird, macht diesen häufigen Fall für den Nutzer
        // unsichtbar.
        for (let attempt = 0; !key && attempt < 15; attempt++) {
          await new Promise((r) => setTimeout(r, 1200));
          key = await getOwnChannelEpochKey(channelId, epochId);
        }
      }
      return key ? { epochId, key } : null;
    },
    [user, getOwnChannelEpochKey, claimChannelEpoch]
  );

  // Läuft bei jeder Änderung am channels-Baum erneut (nicht nur beim Login),
  // damit jedes bereits eingeweihte, gerade geöffnete Mitglied fehlende
  // Channel-Key-Envelopes nachliefert, sobald ein neues Mitglied auftaucht.
  // ensureUserInAllChannels ist idempotent.
  useEffect(() => {
    if (!authReady || !user?.id) return;
    const r = ref(db, "channels");
    const unsub = onValue(r, () => {
      ensureUserInAllChannels();
    });
    return () => unsub();
  }, [authReady, user?.id, ensureUserInAllChannels]);

  // Tritt jemand einem Server bei, ändert sich dabei nur serverMembers, NICHT
  // channels — ohne diesen zusätzlichen Listener würden andere Mitglieder das
  // neue Mitglied nie bemerken und ihm keinen Envelope nachliefern.
  useEffect(() => {
    if (!authReady || !user?.id || servers.length === 0) return;
    const unsubs = servers.map((s) =>
      onValue(ref(db, `serverMembers/${s.id}`), () => {
        ensureUserInAllChannels();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [authReady, user?.id, servers, ensureUserInAllChannels]);

  useEffect(() => {
    if (!authReady || !user?.id || !activeServerId) {
      setChannels([]);
      return;
    }

    const r = ref(db, "channels");

    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() || {}) as Record<string, ChannelDb>;

      const list: Channel[] = Object.entries(raw)
        .filter(
          ([, c]) =>
            c.serverId === activeServerId &&
            (c.restricted ? c.members?.[user.id] : true)
        )
        .map(([id, c]) => ({
          id,
          name: c.name || "ohne-namen",
          description: c.description || "",
          createdAt: c.createdAt || 0,
          createdByEmail: c.createdByEmail || "",
          public: c.public ?? false,
          members: c.members || {},
          serverId: c.serverId,
          restricted: c.restricted,
          announcementOnly: c.announcementOnly,
        }))
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

      setChannels(list);

      if (!activeChannelId && list.length > 0) setActiveChannelId(list[0].id);
      else if (activeChannelId && !list.find((c) => c.id === activeChannelId))
        setActiveChannelId(list[0]?.id || null);
    });

    return () => unsub();
  }, [authReady, user?.id, activeChannelId, activeServerId]);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === activeChannelId) || null,
    [channels, activeChannelId]
  );

  useEffect(() => {
    setChannelMembers([]);
    if (!activeChannelId || !activeChannel) return;

    // Bei eingeschränkten Channels ergibt sich die Mitgliederliste aus der
    // expliziten members-Map dort; bei offenen Channels dagegen aus ALLEN
    // Server-Mitgliedern (channels/{id}/members enthält dort meist nur den
    // Ersteller). Ohne diese Unterscheidung zeigte die Mitgliederliste
    // offener Channels fälschlich nur den Ersteller.
    const r =
      activeChannel.restricted || !activeChannel.serverId
        ? ref(db, `channels/${activeChannelId}/members`)
        : ref(db, `serverMembers/${activeChannel.serverId}`);
    const unsub = onValue(r, (snap) => {
      const memberIds = Object.keys((snap.val() as Record<string, unknown>) || {});
      (async () => {
        const usersSnap = await get(ref(db, "newusers"));
        const allUsers = (usersSnap.val() as Record<string, NewUserDb>) || {};
        const list: Member[] = memberIds
          .map((uid) => {
            const u = allUsers[uid];
            if (user && uid === user.id) {
              return { id: uid, name: user.name, email: user.email, avatar: user.avatar };
            }
            return {
              id: uid,
              name: u?.newname || "Unbekannt",
              email: u?.newemail,
              avatar: u?.avatar,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        setChannelMembers(list);
      })();
    });

    return () => unsub();
  }, [activeChannelId, activeChannel, user]);

  useEffect(() => {
    setPinnedMessageIds(new Set());
    if (!activeChannelId) return;
    const r = ref(db, `channelPins/${activeChannelId}`);
    const unsub = onValue(r, (snap) => {
      setPinnedMessageIds(new Set(Object.keys((snap.val() as Record<string, unknown>) || {})));
    });
    return () => unsub();
  }, [activeChannelId]);

  useEffect(() => {
    setTypingUserIds([]);
    if (!activeChannelId || !user?.id) return;
    const r = ref(db, `typing/${activeChannelId}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, number>) || {};
      const now = Date.now();
      const ids = Object.entries(raw)
        .filter(([uid, ts]) => uid !== user.id && now - ts < 6000)
        .map(([uid]) => uid);
      setTypingUserIds(ids);
    });
    return () => unsub();
  }, [activeChannelId, user?.id]);

  useEffect(() => {
    setMessages([]);
    if (!activeChannelId || !user?.id) return;

    const r = ref(db, `channelMessages/${activeChannelId}`);
    let seq = 0;

    const unsub = onValue(r, (snap) => {
      const mySeq = ++seq;
      const raw =
        (snap.val() as Record<string, ChannelMessageDb> | null) || {};

      (async () => {
        const list = await Promise.all(
          Object.entries(raw).map(([id, m]) =>
            decodeMessage(
              id,
              m,
              (epochId) => resolveChannelKey(activeChannelId, epochId),
              resolveProfile
            )
          )
        );
        list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        if (mySeq === seq) setMessages(list);
      })();
    });

    return () => unsub();
  }, [activeChannelId, user?.id, resolveChannelKey, resolveProfile]);

  useEffect(() => {
    Object.values(reactionUnsubs.current).forEach((fn) => fn());
    reactionUnsubs.current = {};
    Object.values(pollVoteUnsubs.current).forEach((fn) => fn());
    pollVoteUnsubs.current = {};
    Object.values(threadCountUnsubs.current).forEach((fn) => fn());
    threadCountUnsubs.current = {};
    setReactionsByMessage({});
    setPollVotesByMessage({});
    setThreadCountByMessage({});
    setThreadMessagesByParent({});
  }, [activeChannelId]);

  useEffect(() => {
    if (!activeChannelId) return;
    const currentIds = new Set(messages.map((m) => m.id));

    for (const id of Object.keys(reactionUnsubs.current)) {
      if (!currentIds.has(id)) {
        reactionUnsubs.current[id]();
        delete reactionUnsubs.current[id];
      }
    }

    for (const id of currentIds) {
      if (reactionUnsubs.current[id]) continue;
      const r = ref(db, `channelMessageReactions/${activeChannelId}/${id}`);
      const unsub = onValue(r, (snap) => {
        const raw = (snap.val() as Record<string, ReactionDb> | null) || {};
        (async () => {
          const grouped = new Map<string, string[]>();
          for (const [uid, entry] of Object.entries(raw)) {
            const channelKey = await resolveChannelKey(activeChannelId, entry.epochId);
            if (!channelKey) continue;
            try {
              const emoji = await decryptText(channelKey, entry);
              const arr = grouped.get(emoji) || [];
              arr.push(uid);
              grouped.set(emoji, arr);
            } catch {
              continue;
            }
          }

          setReactionsByMessage((prev) => ({
            ...prev,
            [id]: Array.from(grouped.entries()).map(([emoji, uids]) => ({
              emoji,
              uids,
            })),
          }));
        })();
      });
      reactionUnsubs.current[id] = () => off(r, "value", unsub);
    }
  }, [activeChannelId, messages, resolveChannelKey]);

  useEffect(() => {
    if (!activeChannelId) return;
    const currentIds = new Set(messages.map((m) => m.id));

    for (const id of Object.keys(pollVoteUnsubs.current)) {
      if (!currentIds.has(id)) {
        pollVoteUnsubs.current[id]();
        delete pollVoteUnsubs.current[id];
      }
    }

    for (const id of currentIds) {
      if (pollVoteUnsubs.current[id]) continue;
      const r = ref(db, `channelPollVotes/${activeChannelId}/${id}`);
      const unsub = onValue(r, (snap) => {
        const raw = (snap.val() as Record<string, PollVoteDb> | null) || {};
        (async () => {
          const votes: Record<string, number> = {};
          for (const [uid, entry] of Object.entries(raw)) {
            const channelKey = await resolveChannelKey(activeChannelId, entry.epochId);
            if (!channelKey) continue;
            try {
              const text = await decryptText(channelKey, entry);
              const idx = Number(text);
              if (Number.isInteger(idx)) votes[uid] = idx;
            } catch {
              continue;
            }
          }
          setPollVotesByMessage((prev) => ({ ...prev, [id]: votes }));
        })();
      });
      pollVoteUnsubs.current[id] = () => off(r, "value", unsub);
    }
  }, [activeChannelId, messages, resolveChannelKey]);

  useEffect(() => {
    if (!activeChannelId) return;
    const currentIds = new Set(messages.map((m) => m.id));

    for (const id of Object.keys(threadCountUnsubs.current)) {
      if (!currentIds.has(id)) {
        threadCountUnsubs.current[id]();
        delete threadCountUnsubs.current[id];
      }
    }

    for (const id of currentIds) {
      if (threadCountUnsubs.current[id]) continue;
      const r = ref(db, `channelThreadReplies/${activeChannelId}/${id}`);
      const unsub = onValue(r, (snap) => {
        const count = snap.exists() ? Object.keys(snap.val()).length : 0;
        setThreadCountByMessage((prev) =>
          prev[id] === count ? prev : { ...prev, [id]: count }
        );
      });
      threadCountUnsubs.current[id] = () => off(r, "value", unsub);
    }
  }, [activeChannelId, messages]);

  const createChannel = async (
    name: string,
    description?: string,
    restricted?: boolean,
    opts?: { serverIdOverride?: string; skipRateLimit?: boolean; announcementOnly?: boolean }
  ) => {
    setLoading(true);
    setError(null);

    try {
      if (!user?.id) throw new Error("Nicht eingeloggt.");
      const targetServerId = opts?.serverIdOverride || activeServerId;
      if (!targetServerId) throw new Error("Kein Server aktiv.");
      const clean = name.trim().toLowerCase().replace(/\s+/g, "-");
      if (!clean) throw new Error("Ungültiger Channel-Name.");

      const chRef = push(ref(db, "channels"));
      const channelId = chRef.key!;
      const createdAt = Date.now();

      // Kanal-Anlage + Rate-Limit-Zeitstempel atomar in einem Aufruf, damit
      // die Regel erzwingen kann, dass beide zusammengehören. skipRateLimit:
      // beim Anlegen mehrerer Startkanäle direkt bei der Server-Erstellung
      // würde die normale Drossel jeden Kanal außer dem ersten blockieren.
      try {
        await update(ref(db), {
          [`channels/${channelId}`]: {
            name: clean,
            description: (description || "").trim(),
            createdAt,
            createdByEmail: user.email || "",
            public: true,
            serverId: targetServerId,
            restricted: !!restricted,
            ...(opts?.announcementOnly ? { announcementOnly: true } : {}),
            members: { [user.id]: true },
          },
          ...(opts?.skipRateLimit
            ? {}
            : { [`rateLimits/${user.id}/lastChannelCreateAt`]: createdAt }),
        });
      } catch (e) {
        console.error("[ChannelContext] createChannel fehlgeschlagen:", e);
        throw new Error("Channel-Erstellung nicht möglich — evtl. zu schnell hintereinander. Bitte kurz warten und erneut versuchen.");
      }

      const channelKey = await generateChannelKey();
      channelKeyCache.current.set(channelId, channelKey);

      const ownEnvelope = await wrapChannelKeyForMember(channelKey, user.id, {
        bypassCache: true,
      });
      if (ownEnvelope) {
        await set(ref(db, `channelKeys/${channelId}/${user.id}`), ownEnvelope);
      }

      setActiveChannelId(channelId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Fehler beim Erstellen.";
      setError(msg);
      throw e;
    } finally {
      setLoading(false);
    }
  };

  const fanOutMentions = async (
    messageId: string,
    mentionedUids: string[] | undefined
  ) => {
    if (!user?.id || !activeChannelId || !mentionedUids?.length) return;
    const updates: Record<string, unknown> = {};
    for (const uid of mentionedUids) {
      if (uid === user.id) continue;
      const mentionId = push(ref(db, `channelMentions/${uid}`)).key;
      updates[`channelMentions/${uid}/${mentionId}`] = {
        channelId: activeChannelId,
        messageId,
        fromUid: user.id,
        createdAt: Date.now(),
        read: false,
      };
    }
    if (Object.keys(updates).length > 0) {
      await update(ref(db), updates);
    }
  };

  const sendMessage = async (text: string, mentionedUids?: string[]) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");

    const msg = text.trim();
    if (!msg) return;

    const epoch = await getCurrentChannelEpochKey(activeChannelId);
    if (!epoch) {
      throw new Error(
        "Kein Verschlüsselungs-Schlüssel für diesen Channel verfügbar. Bitte kurz warten, bis ihn ein anderes Mitglied bereitgestellt hat."
      );
    }

    const { ciphertext, iv } = await encryptText(epoch.key, msg);
    const signature = await signText(user.id, ciphertext);

    const msgRef = push(ref(db, `channelMessages/${activeChannelId}`));
    const createdAt = Date.now();

    try {
      await update(ref(db), {
        [`channelMessages/${activeChannelId}/${msgRef.key}`]: {
          ciphertext,
          iv,
          senderUid: user.id,
          signature,
          createdAt,
          epochId: epoch.epochId,
        },
        [`rateLimits/${user.id}/lastMessageAt`]: createdAt,
      });
    } catch (e) {
      console.error("[ChannelContext] sendMessage fehlgeschlagen:", e);
      throw new Error("Senden nicht möglich — evtl. zu schnell hintereinander. Bitte kurz warten und erneut versuchen.");
    }

    await fanOutMentions(msgRef.key!, mentionedUids);
  };

  const editMessage = async (messageId: string, newText: string) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");

    const text = newText.trim();
    if (!text) return;

    // Mit demselben Schlüssel neu verschlüsseln, mit dem die Nachricht
    // ursprünglich stand — ihr gespeichertes epochId-Feld bleibt beim
    // Bearbeiten unverändert.
    const existing = messages.find((m) => m.id === messageId);
    const channelKey = await resolveChannelKey(activeChannelId, existing?.epochId);
    if (!channelKey) throw new Error("Kein Verschlüsselungs-Schlüssel verfügbar.");

    const { ciphertext, iv } = await encryptText(channelKey, text);
    const signature = await signText(user.id, ciphertext);

    // Alte Fassung vor dem Überschreiben als Historien-Eintrag sichern,
    // eigener Aufruf statt im selben Mehrfach-Schreibvorgang: der
    // Historien-Pfad ist write-once, ein Fehlschlag dabei soll die
    // eigentliche Bearbeitung nicht blockieren.
    const rawSnap = await get(ref(db, `channelMessages/${activeChannelId}/${messageId}`));
    const raw = rawSnap.val() as ChannelMessageDb | null;
    if (raw?.ciphertext && raw.iv && raw.signature) {
      const editRef = push(ref(db, `channelMessageEdits/${activeChannelId}/${messageId}`));
      await set(editRef, {
        ciphertext: raw.ciphertext,
        iv: raw.iv,
        signature: raw.signature,
        senderUid: user.id,
        editedAt: Date.now(),
      }).catch((e) =>
        console.error("[ChannelContext] Bearbeitungs-Historie konnte nicht gespeichert werden:", e)
      );
    }

    await update(ref(db, `channelMessages/${activeChannelId}/${messageId}`), {
      ciphertext,
      iv,
      signature,
      edited: true,
      editedAt: Date.now(),
    });
  };

  const deleteMessage = async (messageId: string) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");

    await update(ref(db, `channelMessages/${activeChannelId}/${messageId}`), {
      ciphertext: null,
      iv: null,
      signature: null,
      deleted: true,
      deletedAt: Date.now(),
    });
  };

  const pinMessage = async (messageId: string) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");
    await set(ref(db, `channelPins/${activeChannelId}/${messageId}`), {
      pinnedBy: user.id,
      pinnedAt: Date.now(),
    });
  };

  const unpinMessage = async (messageId: string) => {
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");
    await set(ref(db, `channelPins/${activeChannelId}/${messageId}`), null);
  };

  const getMessageEditHistory = async (messageId: string): Promise<EditHistoryEntry[]> => {
    if (!activeChannelId) return [];
    const snap = await get(ref(db, `channelMessageEdits/${activeChannelId}/${messageId}`));
    const raw =
      (snap.val() as Record<
        string,
        { ciphertext: string; iv: string; editedAt: number }
      > | null) || {};
    const msg = messages.find((m) => m.id === messageId);
    const key = await resolveChannelKey(activeChannelId, msg?.epochId);
    const entries = await Promise.all(
      Object.entries(raw).map(async ([id, v]) => {
        if (!key) return { id, text: "🔒", editedAt: v.editedAt };
        try {
          const text = await decryptText(key, { ciphertext: v.ciphertext, iv: v.iv });
          return { id, text, editedAt: v.editedAt };
        } catch {
          return { id, text: "🔒 Nicht entschlüsselbar", editedAt: v.editedAt };
        }
      })
    );
    return entries.sort((a, b) => b.editedAt - a.editedAt);
  };

  const notifyTyping = useCallback(() => {
    if (!user?.id || !activeChannelId) return;
    const now = Date.now();
    if (now - lastTypingNotifyRef.current < 3000) return;
    lastTypingNotifyRef.current = now;
    const r = ref(db, `typing/${activeChannelId}/${user.id}`);
    set(r, now).catch(() => {});
    onDisconnect(r).remove().catch(() => {});
    setTimeout(() => set(r, null).catch(() => {}), 5000);
  }, [user?.id, activeChannelId]);

  const deleteThreadReply = async (parentMessageId: string, replyId: string) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");

    await update(
      ref(
        db,
        `channelThreadReplies/${activeChannelId}/${parentMessageId}/${replyId}`
      ),
      {
        ciphertext: null,
        iv: null,
        signature: null,
        deleted: true,
        deletedAt: Date.now(),
      }
    );
  };

  const toggleReaction = async (messageId: string, emoji: string) => {
    if (!user?.id || !activeChannelId) return;

    const path = `channelMessageReactions/${activeChannelId}/${messageId}/${user.id}`;
    const myCurrent = reactionsByMessage[messageId]?.find((g) =>
      g.uids.includes(user.id)
    );

    if (myCurrent?.emoji === emoji) {
      await set(ref(db, path), null);
      return;
    }

    const epoch = await getCurrentChannelEpochKey(activeChannelId);
    if (!epoch) {
      showToast(
        "Kein Verschlüsselungs-Schlüssel für diesen Channel verfügbar. Bitte kurz warten und erneut versuchen.",
        "error"
      );
      return;
    }

    const { ciphertext, iv } = await encryptText(epoch.key, emoji);
    const signature = await signText(user.id, ciphertext);
    await set(ref(db, path), {
      ciphertext,
      iv,
      signature,
      createdAt: Date.now(),
      epochId: epoch.epochId,
    });
  };

  const votePoll = async (messageId: string, optionIndex: number) => {
    if (!user?.id || !activeChannelId) return;

    const epoch = await getCurrentChannelEpochKey(activeChannelId);
    if (!epoch) {
      showToast(
        "Kein Verschlüsselungs-Schlüssel für diesen Channel verfügbar. Bitte kurz warten und erneut versuchen.",
        "error"
      );
      return;
    }

    const { ciphertext, iv } = await encryptText(epoch.key, String(optionIndex));
    const signature = await signText(user.id, ciphertext);
    await set(ref(db, `channelPollVotes/${activeChannelId}/${messageId}/${user.id}`), {
      ciphertext,
      iv,
      signature,
      createdAt: Date.now(),
      epochId: epoch.epochId,
    });
  };

  const subscribeThread = useCallback(
    (parentMessageId: string): (() => void) => {
      if (!activeChannelId) return () => {};

      const r = ref(
        db,
        `channelThreadReplies/${activeChannelId}/${parentMessageId}`
      );
      let seq = 0;
      const unsub = onValue(r, (snap) => {
        const mySeq = ++seq;
        const raw =
          (snap.val() as Record<string, ChannelMessageDb> | null) || {};

        (async () => {
          const list = await Promise.all(
            Object.entries(raw).map(([id, m]) =>
              decodeMessage(
                id,
                m,
                (epochId) => resolveChannelKey(activeChannelId, epochId),
                resolveProfile
              )
            )
          );
          list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
          if (mySeq !== seq) return;
          setThreadMessagesByParent((prev) => ({
            ...prev,
            [parentMessageId]: list,
          }));
        })();
      });

      return () => off(r, "value", unsub);
    },
    [activeChannelId, resolveChannelKey, resolveProfile]
  );

  const sendThreadReply = async (
    parentMessageId: string,
    text: string,
    mentionedUids?: string[]
  ) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");

    const msg = text.trim();
    if (!msg) return;

    const epoch = await getCurrentChannelEpochKey(activeChannelId);
    if (!epoch) {
      throw new Error("Kein Verschlüsselungs-Schlüssel für diesen Channel verfügbar.");
    }

    const { ciphertext, iv } = await encryptText(epoch.key, msg);
    const signature = await signText(user.id, ciphertext);

    const rRef = push(
      ref(db, `channelThreadReplies/${activeChannelId}/${parentMessageId}`)
    );
    const createdAt = Date.now();

    try {
      await update(ref(db), {
        [`channelThreadReplies/${activeChannelId}/${parentMessageId}/${rRef.key}`]: {
          ciphertext,
          iv,
          senderUid: user.id,
          signature,
          createdAt,
          epochId: epoch.epochId,
        },
        [`rateLimits/${user.id}/lastMessageAt`]: createdAt,
      });
    } catch (e) {
      console.error("[ChannelContext] sendThreadReply fehlgeschlagen:", e);
      throw new Error("Senden nicht möglich — evtl. zu schnell hintereinander. Bitte kurz warten und erneut versuchen.");
    }

    await fanOutMentions(rRef.key!, mentionedUids);
  };

  const inviteToChannel = async (
    channelId: string,
    channelName: string,
    targetUid: string
  ) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    try {
      await set(ref(db, `channelInvites/${targetUid}/${channelId}`), {
        channelId,
        channelName,
        byUid: user.id,
        byName: user.name || "Unbekannt",
        createdAt: Date.now(),
      });
    } catch (e) {
      console.error("[ChannelContext] inviteToChannel fehlgeschlagen:", e);
      throw new Error("Einladung konnte nicht gesendet werden.");
    }
  };

  const setChannelRestricted = async (channelId: string, restricted: boolean) => {
    try {
      await update(ref(db, `channels/${channelId}`), { restricted });
    } catch (e) {
      console.error("[ChannelContext] setChannelRestricted fehlgeschlagen:", e);
      throw new Error("Kanal-Einstellung konnte nicht geändert werden.");
    }
  };

  const setChannelAnnouncementOnly = async (channelId: string, announcementOnly: boolean) => {
    try {
      await update(ref(db, `channels/${channelId}`), { announcementOnly });
    } catch (e) {
      console.error("[ChannelContext] setChannelAnnouncementOnly fehlgeschlagen:", e);
      throw new Error("Kanal-Einstellung konnte nicht geändert werden.");
    }
  };

  const deleteChannel = async (channelId: string) => {
    try {
      // Erst die Blätter (Nachrichten/Schlüssel), dann den Kanal selbst, in
      // getrennten Aufrufen: channelKeys/-Epochs' Rule liest
      // channels/{id}.serverId, das darf im selben Mehrfach-Schreibvorgang,
      // in dem channels/{id} mitgelöscht würde, nicht schon weg sein.
      await update(ref(db), {
        [`channelMessages/${channelId}`]: null,
        [`channelMessageReactions/${channelId}`]: null,
        [`channelPollVotes/${channelId}`]: null,
        [`channelThreadReplies/${channelId}`]: null,
        [`channelKeys/${channelId}`]: null,
        [`channelKeyEpochs/${channelId}`]: null,
      });
      await update(ref(db), { [`channels/${channelId}`]: null });
      if (activeChannelId === channelId) setActiveChannelId(null);
    } catch (e) {
      console.error("[ChannelContext] deleteChannel fehlgeschlagen:", e);
      throw new Error("Kanal konnte nicht gelöscht werden.");
    }
  };

  return (
    <ChannelContext.Provider
      value={{
        channels,
        activeChannelId,
        activeChannel,
        channelMembers,
        messages,
        reactionsByMessage,
        pollVotesByMessage,
        votePoll,
        threadCountByMessage,
        threadMessagesByParent,
        setActiveChannelId,
        createChannel,
        inviteToChannel,
        setChannelRestricted,
        setChannelAnnouncementOnly,
        deleteChannel,
        sendMessage,
        editMessage,
        deleteMessage,
        toggleReaction,
        subscribeThread,
        sendThreadReply,
        deleteThreadReply,
        pinnedMessageIds,
        pinMessage,
        unpinMessage,
        getMessageEditHistory,
        typingUserIds,
        notifyTyping,
        loading,
        error,
      }}
    >
      {children}
    </ChannelContext.Provider>
  );
}

export function useChannel() {
  const ctx = useContext(ChannelContext);
  if (!ctx) throw new Error("useChannel must be used within ChannelProvider");
  return ctx;
}
