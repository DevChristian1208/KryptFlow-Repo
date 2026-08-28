"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from "react";
import {
  ref,
  onValue,
  off,
  push,
  set,
  get,
  update,
  query,
  orderByChild,
  startAt,
} from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "./UserContext";
import { useToast } from "./ToastContext";
import {
  deriveDmKey,
  ensureDmPeriodRoot,
  getPeriodRoot,
  getSendMessageKey,
  getReceiveMessageKey,
  getCachedPlaintext,
  setCachedPlaintext,
  encryptText,
  decryptText,
  signText,
  verifyText,
  fetchPublicIdentity,
  type EncryptedPayload,
  type MsgCategory,
} from "@/app/lib/crypto";
import type { ReactionGroup, Profile } from "./ChannelContext";

/* -----------------------------------------
 * TYPES
 * ---------------------------------------*/
export type InviteKind = "channelInvite" | "serverInvite";

export type InvitePayload = {
  channelId?: string;
  channelName?: string;
  serverId?: string;
  serverName?: string;
  byUid: string;
  byName: string;
};

export type ChatMessage = {
  id: string;
  text: string;
  createdAt?: number;
  user: { name: string; email: string; avatar?: string };
  senderUid?: string;
  verified?: boolean;
  edited?: boolean;
  editedAt?: number;
  deleted?: boolean;
  periodId?: string;
  seq?: number;
  kind?: InviteKind;
  invite?: InvitePayload;
};

type DMDbMessage = {
  ciphertext?: string;
  iv?: string;
  senderUid?: string;
  signature?: string;
  createdAt: number;
  edited?: boolean;
  editedAt?: number;
  deleted?: boolean;
  deletedAt?: number;
  periodId?: string;
  seq?: number;
  // Unverschlüsseltes Typ-Tag für Einladungs-Systemnachrichten (Chat-Karte
  // statt normalem Text) — der eigentliche Inhalt (Kanal-/Servername etc.)
  // bleibt Teil des verschlüsselten ciphertext, das Tag selbst verrät dem
  // Server nur "diese Nachricht ist eine Einladungskarte", nicht den Inhalt.
  kind?: InviteKind;
  // Legacy-Feld aus der Zeit vor der Verschlüsselungs-Umstellung:
  text?: string;
  from?: { id: string; name: string; email: string; avatar?: string };
};

type ReactionDb = EncryptedPayload & {
  signature: string;
  createdAt: number;
  periodId?: string;
  seq?: number;
};

export type DMThread = {
  convId: string;
  otherUserId: string;
  otherName: string;
  otherAvatar?: string;
  lastMessageAt?: number;
  lastReadAt?: number;
};

// meta in db: dmThreads/<uid>/<otherUid>
type DMThreadMeta = {
  otherName?: string;
  otherAvatar?: string;
  lastMessageAt?: number;
  lastReadAt?: number;
};

// entire thread list for one user
type DMThreadsDb = Record<string, DMThreadMeta>;

// directMessages/<convId>
type DirectMessagesDb = Record<string, DMDbMessage>;

type DirectContextType = {
  activeDMUserId: string | null;
  activeDMUser: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  } | null;
  dmMessages: ChatMessage[];
  dmThreads: DMThread[];
  unreadCounts: Record<string, number>;
  reactionsByMessage: Record<string, ReactionGroup[]>;
  threadCountByMessage: Record<string, number>;
  threadMessagesByParent: Record<string, ChatMessage[]>;
  startDMWith: (otherUserId: string) => Promise<void>;
  sendDirectMessage: (text: string) => Promise<void>;
  sendDirectSystemMessage: (
    otherUserId: string,
    kind: InviteKind,
    invite: InvitePayload
  ) => Promise<void>;
  editDirectMessage: (messageId: string, newText: string) => Promise<void>;
  deleteDirectMessage: (messageId: string) => Promise<void>;
  toggleDirectReaction: (messageId: string, emoji: string) => Promise<void>;
  subscribeDirectThread: (parentMessageId: string) => () => void;
  sendDirectThreadReply: (parentMessageId: string, text: string) => Promise<void>;
  deleteDirectThreadReply: (parentMessageId: string, replyId: string) => Promise<void>;
  clearDM: () => void;
  friends: { id: string; name: string; avatar?: string }[];
  isBlocked: (uid: string) => boolean;
  blockUser: (uid: string) => Promise<void>;
  unblockUser: (uid: string) => Promise<void>;
};

const DirectContext = createContext<DirectContextType | undefined>(undefined);

function convIdFromIds(a: string, b: string) {
  return [a, b].sort().join("__");
}

type NewUserDb = {
  authUid?: string;
  newname?: string;
  newemail?: string;
  avatar?: string;
};

/** Entschlüsselt+verifiziert eine einzelne DM-/Thread-Nachricht.
 *
 * Für geratchete Nachrichten (`m.periodId` gesetzt) wird zuerst ein
 * persistenter Klartext-Cache geprüft: der Message-Key wird nach dem ersten
 * erfolgreichen Entschlüsseln von der Ratchet-Kette verworfen (Forward
 * Secrecy), die App entschlüsselt aber bei jedem Firebase-Snapshot die
 * komplette Liste neu — ohne diesen Cache würde jede bereits gelesene
 * Nachricht beim nächsten erneuten Rendern dauerhaft "🔒 kann nicht
 * entschlüsselt werden" anzeigen (siehe crypto.ts, getCachedDmPlaintext). */
async function decodeDmMessage(
  id: string,
  m: DMDbMessage,
  resolveKey: (m: DMDbMessage) => Promise<CryptoKey | null>,
  myProfile: Profile,
  myUid: string,
  otherProfile: Profile,
  convId: string,
  kind: "msg" | "thread"
): Promise<ChatMessage> {
  if (m.deleted) {
    const mine = m.senderUid === myUid;
    return {
      id,
      text: "Nachricht gelöscht",
      createdAt: m.createdAt,
      user: mine ? myProfile : otherProfile,
      senderUid: m.senderUid,
      deleted: true,
    };
  }

  if (!m.ciphertext && m.text) {
    return {
      id,
      text: m.text,
      createdAt: m.createdAt,
      user: {
        name: m.from?.name ?? "Unbekannt",
        email: m.from?.email ?? "",
        avatar: m.from?.avatar,
      },
    };
  }

  const mine = m.senderUid === myUid;
  const senderProfile = mine ? myProfile : otherProfile;

  if (!m.ciphertext || !m.iv || !m.senderUid) {
    return {
      id,
      text: "🔒 Nachricht kann nicht gelesen werden.",
      createdAt: m.createdAt,
      user: senderProfile,
    };
  }

  // Einladungs-Systemnachrichten tragen ihren eigentlichen Inhalt als
  // JSON-String im entschlüsselten Text — hier einmalig zentral geparst,
  // damit Cache-Treffer und frisch entschlüsselte Nachrichten denselben Weg
  // gehen.
  function finalize(text: string, verified: boolean | undefined): ChatMessage {
    if (m.kind) {
      try {
        const invite = JSON.parse(text) as InvitePayload;
        return {
          id,
          text: "",
          createdAt: m.createdAt,
          user: senderProfile,
          senderUid: m.senderUid,
          verified,
          periodId: m.periodId,
          seq: m.seq,
          kind: m.kind,
          invite,
        };
      } catch {
        // fällt durch zur normalen Textdarstellung, falls das Parsen
        // fehlschlägt (z. B. Alt-Daten)
      }
    }
    return {
      id,
      text:
        verified === false
          ? `⚠️ Signatur ungültig – Nachricht könnte manipuliert sein: ${text}`
          : text,
      createdAt: m.createdAt,
      user: senderProfile,
      senderUid: m.senderUid,
      verified,
      edited: m.edited,
      editedAt: m.editedAt,
      periodId: m.periodId,
      seq: m.seq,
    };
  }

  if (m.periodId) {
    const cached = await getCachedPlaintext(convId, kind, id);
    if (cached) {
      return finalize(cached.text, cached.verified);
    }
  }

  try {
    const dmKey = await resolveKey(m);
    if (!dmKey) {
      return {
        id,
        text: "🔒 Warte auf Verschlüsselungs-Schlüssel …",
        createdAt: m.createdAt,
        user: senderProfile,
      };
    }

    const text = await decryptText(dmKey, { ciphertext: m.ciphertext, iv: m.iv });

    let verified: boolean | undefined;
    if (m.signature) {
      const senderIdentity = await fetchPublicIdentity(m.senderUid);
      verified = senderIdentity
        ? await verifyText(senderIdentity.ecdsa, m.ciphertext, m.signature)
        : false;
    }

    if (m.periodId) {
      await setCachedPlaintext(convId, kind, id, { text, verified });
    }

    return finalize(text, verified);
  } catch {
    return {
      id,
      text: "🔒 Nachricht kann nicht entschlüsselt werden.",
      createdAt: m.createdAt,
      user: senderProfile,
    };
  }
}

/**
 * Löst den Schlüssel für eine DM-Nachricht auf: mit `periodId`+`seq`
 * (Ratchet-Nachricht) wird die passende Perioden-Wurzel geholt und der
 * mitverfolgte Empfangs-Kettenschritt für den Absender berechnet — ohne
 * `periodId` (Alt-Nachrichten von vor dieser Umstellung, oder die ersten
 * Nachrichten einer Konversation vor Etablierung der ersten Periode) greift
 * der bisherige statisch abgeleitete Schlüssel als Fallback.
 */
async function resolveDmKeyForMessage(
  m: DMDbMessage,
  myUid: string,
  otherUid: string,
  category: MsgCategory
): Promise<CryptoKey | null> {
  if (m.periodId && m.seq !== undefined && m.senderUid) {
    const root = await getPeriodRoot(myUid, otherUid, m.periodId);
    if (!root) return null;
    return getReceiveMessageKey(
      convIdFromIds(myUid, otherUid),
      m.senderUid,
      m.periodId,
      root,
      m.seq,
      category
    );
  }
  return deriveDmKey(myUid, otherUid);
}

export function DirectProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const { showToast } = useToast();

  const [activeDMUserId, setActiveDMUserId] = useState<string | null>(null);
  const [activeDMUser, setActiveDMUser] = useState<{
    id: string;
    name: string;
    email: string;
    avatar?: string;
  } | null>(null);

  const [dmMessages, setDmMessages] = useState<ChatMessage[]>([]);
  const [dmThreads, setDmThreads] = useState<DMThread[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [reactionsByMessage, setReactionsByMessage] = useState<
    Record<string, ReactionGroup[]>
  >({});
  const [threadCountByMessage, setThreadCountByMessage] = useState<
    Record<string, number>
  >({});
  const [threadMessagesByParent, setThreadMessagesByParent] = useState<
    Record<string, ChatMessage[]>
  >({});

  const [friends, setFriends] = useState<
    { id: string; name: string; avatar?: string }[]
  >([]);
  const [blockedUids, setBlockedUids] = useState<Set<string>>(new Set());

  const messagesRef = useRef<ReturnType<typeof ref> | null>(null);
  const threadsRef = useRef<ReturnType<typeof ref> | null>(null);
  const reactionUnsubs = useRef<Record<string, () => void>>({});
  const threadCountUnsubs = useRef<Record<string, () => void>>({});

  const isGuest = user?.isGuest === true;
  const dmDisabled = isGuest || !user?.id;

  // Wechselt der eingeloggte Nutzer im selben Tab (Logout -> anderer Login,
  // DirectProvider wird dabei nicht neu gemountet), darf ein zuvor aktiver
  // DM nicht für den neuen Nutzer stehen bleiben.
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = user?.id ?? null;
    if (prevUserIdRef.current !== null && prevUserIdRef.current !== uid) {
      setActiveDMUserId(null);
      setActiveDMUser(null);
      setDmMessages([]);
    }
    prevUserIdRef.current = uid;
  }, [user?.id]);

  const myProfile: Profile = useMemo(
    () => ({
      name: user?.name || "",
      email: user?.email || "",
      avatar: user?.avatar || "/avatar1.png",
    }),
    [user?.name, user?.email, user?.avatar]
  );
  const otherProfile: Profile = useMemo(
    () => ({
      name: activeDMUser?.name || "Unbekannt",
      email: activeDMUser?.email || "",
      avatar: activeDMUser?.avatar || "/avatar1.png",
    }),
    [activeDMUser?.name, activeDMUser?.email, activeDMUser?.avatar]
  );

  /* -----------------------------------------
   * THREADS LADEN
   * ---------------------------------------*/
  useEffect(() => {
    if (messagesRef.current) {
      off(messagesRef.current);
      messagesRef.current = null;
    }
    if (threadsRef.current) {
      off(threadsRef.current);
      threadsRef.current = null;
    }

    setDmThreads([]);
    setUnreadCounts({});

    if (dmDisabled) return;

    const r = ref(db, `dmThreads/${user!.id}`);
    threadsRef.current = r;

    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as DMThreadsDb | null) || {};

      const entries = Object.entries(raw).filter(
        ([otherUserId]) =>
          otherUserId && otherUserId !== user!.id && otherUserId !== "undefined"
      );

      const list: DMThread[] = entries.map(([otherUserId, meta]) => ({
        convId: convIdFromIds(user!.id, otherUserId),
        otherUserId,
        otherName: meta?.otherName || "Unbekannt",
        otherAvatar: meta?.otherAvatar || "/avatar1.png",
        lastMessageAt: meta?.lastMessageAt ?? 0,
        lastReadAt: meta?.lastReadAt ?? 0,
      }));

      list.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
      setDmThreads(list);
    });

    return () => {
      off(r);
      threadsRef.current = null;
      unsub();
    };
  }, [user?.id, dmDisabled]);

  /* -----------------------------------------
   * FREUNDE
   * ---------------------------------------*/
  useEffect(() => {
    setFriends([]);
    if (dmDisabled) return;

    const r = ref(db, `friends/${user!.id}`);
    const unsub = onValue(r, (snap) => {
      const raw =
        (snap.val() as Record<
          string,
          { name?: string; avatar?: string } | true
        > | null) || {};
      const list = Object.entries(raw).map(([uid, v]) => ({
        id: uid,
        name: (typeof v === "object" && v?.name) || "Unbekannt",
        avatar: typeof v === "object" ? v?.avatar : undefined,
      }));
      list.sort((a, b) => a.name.localeCompare(b.name));
      setFriends(list);
    });

    return () => off(r, "value", unsub);
  }, [user?.id, dmDisabled]);

  /* -----------------------------------------
   * BLOCKIERTE NUTZER (nur client-seitig durchgesetzt, siehe sendDirectMessage)
   * ---------------------------------------*/
  useEffect(() => {
    setBlockedUids(new Set());
    if (dmDisabled) return;

    const r = ref(db, `blocked/${user!.id}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, true> | null) || {};
      setBlockedUids(new Set(Object.keys(raw)));
    });

    return () => off(r, "value", unsub);
  }, [user?.id, dmDisabled]);

  const isBlocked = useCallback(
    (uid: string) => blockedUids.has(uid),
    [blockedUids]
  );

  const blockUser = useCallback(
    async (uid: string) => {
      if (!user?.id) return;
      await set(ref(db, `blocked/${user.id}/${uid}`), true);
    },
    [user?.id]
  );

  const unblockUser = useCallback(
    async (uid: string) => {
      if (!user?.id) return;
      await set(ref(db, `blocked/${user.id}/${uid}`), null);
    },
    [user?.id]
  );

  /* -----------------------------------------
   * UNREAD COUNTS
   * ---------------------------------------*/
  const unreadListeners = useRef<Record<string, () => void>>({});
  useEffect(() => {
    Object.values(unreadListeners.current).forEach((fn) => fn?.());
    unreadListeners.current = {};

    if (dmDisabled || dmThreads.length === 0) return;

    dmThreads.forEach((t) => {
      const since = (t.lastReadAt ?? 0) + 1;

      const qref =
        since > 1
          ? query(
              ref(db, `directMessages/${t.convId}`),
              orderByChild("createdAt"),
              startAt(since)
            )
          : ref(db, `directMessages/${t.convId}`);

      const unsub = onValue(qref, (snap) => {
        const val = (snap.val() as DirectMessagesDb | null) || {};
        let count = 0;

        Object.values(val).forEach((m) => {
          const senderId = m.senderUid ?? m.from?.id;
          if (m.createdAt > (t.lastReadAt ?? 0) && senderId !== user!.id) {
            count++;
          }
        });

        setUnreadCounts((prev) =>
          prev[t.otherUserId] === count
            ? prev
            : { ...prev, [t.otherUserId]: count }
        );
      });

      unreadListeners.current[t.otherUserId] = () => off(qref, "value", unsub);
    });

    return () => {
      Object.values(unreadListeners.current).forEach((fn) => fn?.());
      unreadListeners.current = {};
    };
  }, [dmThreads, user?.id, dmDisabled]);

  /* -----------------------------------------
   * DM NACHRICHTEN LADEN, ENTSCHLÜSSELN, VERIFIZIEREN
   * ---------------------------------------*/
  useEffect(() => {
    if (messagesRef.current) {
      off(messagesRef.current);
      messagesRef.current = null;
    }

    setDmMessages([]);

    if (dmDisabled || !activeDMUserId) return;

    const cid = convIdFromIds(user!.id, activeDMUserId);
    const r = ref(db, `directMessages/${cid}`);
    messagesRef.current = r;
    let seq = 0;

    const unsub = onValue(r, (snap) => {
      const mySeq = ++seq;
      const val = (snap.val() as DirectMessagesDb | null) || {};

      (async () => {
        const list = await Promise.all(
          Object.entries(val).map(([id, m]) =>
            decodeDmMessage(
              id,
              m,
              (msg) => resolveDmKeyForMessage(msg, user!.id, activeDMUserId, "msg"),
              myProfile,
              user!.id,
              otherProfile,
              cid,
              "msg"
            )
          )
        );
        list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        // Nur übernehmen, falls inzwischen kein neuerer Snapshot eingetroffen
        // ist (verhindert, dass eine langsamere ältere Entschlüsselung eine
        // bereits aktuellere Liste überschreibt).
        if (mySeq !== seq) return;
        setDmMessages(list);
      })();

      // Läuft bei jedem neuen Snapshot, solange dieser DM aktiv geöffnet ist
      // — verhindert, dass der Ungelesen-Zähler für die gerade angeschaute
      // Konversation trotzdem hochzählt.
      update(ref(db, `dmThreads/${user!.id}/${activeDMUserId}`), {
        lastReadAt: Date.now(),
      }).catch(() => {});
      setUnreadCounts((prev) =>
        prev[activeDMUserId] ? { ...prev, [activeDMUserId]: 0 } : prev
      );
    });

    return () => {
      off(r, "value", unsub);
      messagesRef.current = null;
    };
  }, [activeDMUserId, dmDisabled, user, myProfile, otherProfile]);

  /* -----------------------------------------
   * Reaktionen & Thread-Zähler pro sichtbarer DM-Nachricht
   * ---------------------------------------*/
  useEffect(() => {
    Object.values(reactionUnsubs.current).forEach((fn) => fn());
    reactionUnsubs.current = {};
    Object.values(threadCountUnsubs.current).forEach((fn) => fn());
    threadCountUnsubs.current = {};
    setReactionsByMessage({});
    setThreadCountByMessage({});
    setThreadMessagesByParent({});
  }, [activeDMUserId]);

  useEffect(() => {
    if (dmDisabled || !activeDMUserId || !user?.id) return;
    const cid = convIdFromIds(user.id, activeDMUserId);
    const currentIds = new Set(dmMessages.map((m) => m.id));

    for (const id of Object.keys(reactionUnsubs.current)) {
      if (!currentIds.has(id)) {
        reactionUnsubs.current[id]();
        delete reactionUnsubs.current[id];
      }
    }

    for (const id of currentIds) {
      if (reactionUnsubs.current[id]) continue;
      const r = ref(db, `directMessageReactions/${cid}/${id}`);
      const unsub = onValue(r, (snap) => {
        const raw = (snap.val() as Record<string, ReactionDb> | null) || {};
        (async () => {
          const grouped = new Map<string, string[]>();
          for (const [uid, entry] of Object.entries(raw)) {
            const reactionId = `${id}:${uid}`;
            try {
              if (entry.periodId) {
                const cached = await getCachedPlaintext(cid, "reaction", reactionId);
                if (cached) {
                  const arr = grouped.get(cached.text) || [];
                  arr.push(uid);
                  grouped.set(cached.text, arr);
                  continue;
                }
              }

              const dmKey = await resolveDmKeyForMessage(
                {
                  senderUid: uid,
                  ciphertext: entry.ciphertext,
                  iv: entry.iv,
                  createdAt: entry.createdAt,
                  periodId: entry.periodId,
                  seq: entry.seq,
                },
                user.id,
                activeDMUserId,
                "reaction"
              );
              if (!dmKey) continue;

              const emoji = await decryptText(dmKey, entry);
              if (entry.periodId) {
                await setCachedPlaintext(cid, "reaction", reactionId, { text: emoji });
              }
              const arr = grouped.get(emoji) || [];
              arr.push(uid);
              grouped.set(emoji, arr);
            } catch {
              // nicht entschlüsselbare Reaktion überspringen
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
  }, [activeDMUserId, dmMessages, dmDisabled, user?.id]);

  useEffect(() => {
    if (dmDisabled || !activeDMUserId || !user?.id) return;
    const cid = convIdFromIds(user.id, activeDMUserId);
    const currentIds = new Set(dmMessages.map((m) => m.id));

    for (const id of Object.keys(threadCountUnsubs.current)) {
      if (!currentIds.has(id)) {
        threadCountUnsubs.current[id]();
        delete threadCountUnsubs.current[id];
      }
    }

    for (const id of currentIds) {
      if (threadCountUnsubs.current[id]) continue;
      const r = ref(db, `directThreadReplies/${cid}/${id}`);
      const unsub = onValue(r, (snap) => {
        const count = snap.exists() ? Object.keys(snap.val()).length : 0;
        setThreadCountByMessage((prev) =>
          prev[id] === count ? prev : { ...prev, [id]: count }
        );
      });
      threadCountUnsubs.current[id] = () => off(r, "value", unsub);
    }
  }, [activeDMUserId, dmMessages, dmDisabled, user?.id]);

  /* -----------------------------------------
   * START DM
   * ---------------------------------------*/
  const startDMWith = useCallback(
    async (otherUserId: string) => {
      if (dmDisabled) {
        showToast("Direktnachrichten sind nur für registrierte Nutzer verfügbar.", "info");
        return;
      }
      if (!user?.id || !otherUserId || user.id === otherUserId) return;

      let other = {
        id: otherUserId,
        name: "Unbekannt",
        email: "",
        avatar: "/avatar1.png",
      };

      const snap = await get(ref(db, `newusers/${otherUserId}`));
      if (snap.exists()) {
        const d = snap.val() as NewUserDb;
        other = {
          id: otherUserId,
          name: d.newname || "Unbekannt",
          email: d.newemail || "",
          avatar: d.avatar || "/avatar1.png",
        };
      }

      setActiveDMUserId(otherUserId);
      setActiveDMUser(other);

      await update(ref(db, `dmThreads/${user.id}/${otherUserId}`), {
        otherName: other.name,
        otherAvatar: other.avatar,
      });

      await update(ref(db, `dmThreads/${otherUserId}/${user.id}`), {
        otherName: user.name,
        otherAvatar: user.avatar || "/avatar1.png",
      });
    },
    [user, dmDisabled, showToast]
  );

  /* -----------------------------------------
   * SEND MESSAGE: verschlüsseln + signieren
   * ---------------------------------------*/
  const sendDirectMessage = useCallback(
    async (text: string) => {
      if (dmDisabled) {
        showToast("Direktnachrichten sind nur für registrierte Nutzer verfügbar.", "info");
        return;
      }

      if (!user?.id || !activeDMUserId) return;

      if (blockedUids.has(activeDMUserId)) {
        showToast("Du hast diese Person blockiert.", "error");
        return;
      }

      const msg = text.trim();
      if (!msg) return;

      const cid = convIdFromIds(user!.id, activeDMUserId);
      const now = Date.now();

      // Ratchet-Schlüssel bevorzugen (Forward Secrecy); ist noch keine
      // Periode etabliert (allererste Nachricht(en) einer Konversation,
      // oder Gegenseite noch nicht reagiert), auf den statisch abgeleiteten
      // Schlüssel zurückfallen — die Nachricht bleibt dann ohne periodId/seq
      // und wird beim Lesen entsprechend über denselben Fallback entschlüsselt.
      const period = await ensureDmPeriodRoot(user.id, activeDMUserId);
      let ciphertext: string, iv: string, ratchetMeta: { periodId?: string; seq?: number };
      if (period) {
        const { key, seq } = await getSendMessageKey(
          cid,
          user.id,
          period.periodId,
          period.rootBytes,
          "msg"
        );
        ({ ciphertext, iv } = await encryptText(key, msg));
        ratchetMeta = { periodId: period.periodId, seq };
      } else {
        const dmKey = await deriveDmKey(user.id, activeDMUserId);
        if (!dmKey) {
          showToast(
            "Verschlüsselung für diesen Kontakt ist noch nicht verfügbar. Bitte kurz warten und erneut versuchen.",
            "error"
          );
          return;
        }
        ({ ciphertext, iv } = await encryptText(dmKey, msg));
        ratchetMeta = {};
      }

      const signature = await signText(user.id, ciphertext);

      let toMeta = activeDMUser;

      if (!toMeta) {
        const snap = await get(ref(db, `newusers/${activeDMUserId}`));
        if (snap.exists()) {
          const d = snap.val() as NewUserDb;
          toMeta = {
            id: activeDMUserId,
            name: d.newname || "Unbekannt",
            email: d.newemail || "",
            avatar: d.avatar || "/avatar1.png",
          };
        } else {
          toMeta = {
            id: activeDMUserId,
            name: "Unbekannt",
            email: "",
            avatar: "/avatar1.png",
          };
        }
      }

      const newRef = push(ref(db, `directMessages/${cid}`));
      try {
        await update(ref(db), {
          [`directMessages/${cid}/${newRef.key}`]: {
            ciphertext,
            iv,
            senderUid: user.id,
            signature,
            createdAt: now,
            ...ratchetMeta,
          },
          [`rateLimits/${user.id}/lastMessageAt`]: now,
        });
      } catch (e) {
        console.error("[DirectContext] sendDirectMessage fehlgeschlagen:", e);
        showToast(
          "Senden nicht möglich — evtl. zu schnell hintereinander. Bitte kurz warten und erneut versuchen.",
          "error"
        );
        return;
      }

      await update(ref(db, `dmThreads/${user.id}/${activeDMUserId}`), {
        otherName: toMeta.name,
        otherAvatar: toMeta.avatar,
        lastMessageAt: now,
      });

      await update(ref(db, `dmThreads/${activeDMUserId}/${user.id}`), {
        otherName: user.name,
        otherAvatar: user.avatar || "/avatar1.png",
        lastMessageAt: now,
      });
    },
    [user, activeDMUserId, activeDMUser, dmDisabled, showToast, blockedUids]
  );

  /* -----------------------------------------
   * SYSTEMNACHRICHT SENDEN (Einladungskarten) — anders als sendDirectMessage
   * an ein beliebiges Ziel statt an die gerade geöffnete Konversation, da
   * eine Einladung z. B. aus dem Mitglieder-/Server-Einladungsdialog heraus
   * verschickt wird, nicht zwingend aus einem offenen DM-Fenster.
   * ---------------------------------------*/
  const sendDirectSystemMessage = useCallback(
    async (otherUserId: string, kind: InviteKind, invite: InvitePayload) => {
      if (dmDisabled || !user?.id || otherUserId === user.id) return;
      if (blockedUids.has(otherUserId)) return;

      const cid = convIdFromIds(user.id, otherUserId);
      const now = Date.now();
      const payload = JSON.stringify(invite);

      const period = await ensureDmPeriodRoot(user.id, otherUserId);
      let ciphertext: string, iv: string, ratchetMeta: { periodId?: string; seq?: number };
      if (period) {
        const { key, seq } = await getSendMessageKey(
          cid,
          user.id,
          period.periodId,
          period.rootBytes,
          "msg"
        );
        ({ ciphertext, iv } = await encryptText(key, payload));
        ratchetMeta = { periodId: period.periodId, seq };
      } else {
        const dmKey = await deriveDmKey(user.id, otherUserId);
        if (!dmKey) return;
        ({ ciphertext, iv } = await encryptText(dmKey, payload));
        ratchetMeta = {};
      }

      const signature = await signText(user.id, ciphertext);

      const snap = await get(ref(db, `newusers/${otherUserId}`));
      const d = snap.exists() ? (snap.val() as NewUserDb) : null;
      const otherName = d?.newname || "Unbekannt";
      const otherAvatar = d?.avatar || "/avatar1.png";

      const newRef = push(ref(db, `directMessages/${cid}`));
      try {
        await update(ref(db), {
          [`directMessages/${cid}/${newRef.key}`]: {
            ciphertext,
            iv,
            senderUid: user.id,
            signature,
            createdAt: now,
            kind,
            ...ratchetMeta,
          },
          [`dmThreads/${user.id}/${otherUserId}/otherName`]: otherName,
          [`dmThreads/${user.id}/${otherUserId}/otherAvatar`]: otherAvatar,
          [`dmThreads/${user.id}/${otherUserId}/lastMessageAt`]: now,
          [`dmThreads/${otherUserId}/${user.id}/otherName`]: user.name,
          [`dmThreads/${otherUserId}/${user.id}/otherAvatar`]: user.avatar || "/avatar1.png",
          [`dmThreads/${otherUserId}/${user.id}/lastMessageAt`]: now,
        });
      } catch (e) {
        console.error("[DirectContext] sendDirectSystemMessage fehlgeschlagen:", e);
      }
    },
    [user, dmDisabled, blockedUids]
  );

  /* -----------------------------------------
   * NACHRICHT BEARBEITEN
   * ---------------------------------------*/
  const editDirectMessage = useCallback(
    async (messageId: string, newText: string) => {
      if (!user?.id || !activeDMUserId) throw new Error("Nicht eingeloggt.");
      const text = newText.trim();
      if (!text) return;

      const existing = dmMessages.find((m) => m.id === messageId);
      if (existing?.periodId) {
        // Ratchet-Nachrichten sind bewusst unveränderlich: der zum
        // ursprünglichen Verschlüsseln verwendete Kettenschlüssel ist nach
        // dem Senden bereits verworfen (genau das ist der Sinn von Forward
        // Secrecy) und kann nicht zum erneuten Verschlüsseln wiederverwendet
        // werden. Löschen (Tombstone) funktioniert weiterhin, da dafür kein
        // Schlüssel gebraucht wird.
        throw new Error(
          "Diese Nachricht kann nicht mehr bearbeitet werden (Perfect-Forward-Secrecy-Schlüssel wurde bereits verworfen)."
        );
      }

      const cid = convIdFromIds(user.id, activeDMUserId);
      const dmKey = await deriveDmKey(user.id, activeDMUserId);
      if (!dmKey) throw new Error("Verschlüsselung nicht verfügbar.");

      const { ciphertext, iv } = await encryptText(dmKey, text);
      const signature = await signText(user.id, ciphertext);

      await update(ref(db, `directMessages/${cid}/${messageId}`), {
        ciphertext,
        iv,
        signature,
        edited: true,
        editedAt: Date.now(),
      });
    },
    [user, activeDMUserId, dmMessages]
  );

  /* -----------------------------------------
   * NACHRICHT LÖSCHEN (Soft-Delete/Tombstone)
   * ---------------------------------------*/
  const deleteDirectMessage = useCallback(
    async (messageId: string) => {
      if (!user?.id || !activeDMUserId) throw new Error("Nicht eingeloggt.");
      const cid = convIdFromIds(user.id, activeDMUserId);

      await update(ref(db, `directMessages/${cid}/${messageId}`), {
        ciphertext: null,
        iv: null,
        signature: null,
        deleted: true,
        deletedAt: Date.now(),
      });
    },
    [user, activeDMUserId]
  );

  /* -----------------------------------------
   * REAKTION TOGGELN
   * ---------------------------------------*/
  const toggleDirectReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !activeDMUserId) return;
      if (blockedUids.has(activeDMUserId)) {
        showToast("Du hast diese Person blockiert.", "error");
        return;
      }

      const cid = convIdFromIds(user.id, activeDMUserId);
      const path = `directMessageReactions/${cid}/${messageId}/${user.id}`;
      const myCurrent = reactionsByMessage[messageId]?.find((g) =>
        g.uids.includes(user.id)
      );

      if (myCurrent?.emoji === emoji) {
        await set(ref(db, path), null);
        return;
      }

      const period = await ensureDmPeriodRoot(user.id, activeDMUserId);
      let ciphertext: string, iv: string, extra: { periodId?: string; seq?: number };
      if (period) {
        const { key, seq } = await getSendMessageKey(
          cid,
          user.id,
          period.periodId,
          period.rootBytes,
          "reaction"
        );
        ({ ciphertext, iv } = await encryptText(key, emoji));
        extra = { periodId: period.periodId, seq };
      } else {
        const dmKey = await deriveDmKey(user.id, activeDMUserId);
        if (!dmKey) {
          showToast(
            "Verschlüsselung für diesen Kontakt ist noch nicht verfügbar. Bitte kurz warten und erneut versuchen.",
            "error"
          );
          return;
        }
        ({ ciphertext, iv } = await encryptText(dmKey, emoji));
        extra = {};
      }

      const signature = await signText(user.id, ciphertext);
      await set(ref(db, path), {
        ciphertext,
        iv,
        signature,
        createdAt: Date.now(),
        ...extra,
      });
    },
    [user, activeDMUserId, reactionsByMessage, showToast, blockedUids]
  );

  /* -----------------------------------------
   * THREAD-ANTWORTEN
   * ---------------------------------------*/
  const subscribeDirectThread = useCallback(
    (parentMessageId: string): (() => void) => {
      if (!user?.id || !activeDMUserId) return () => {};
      const cid = convIdFromIds(user.id, activeDMUserId);

      const r = ref(db, `directThreadReplies/${cid}/${parentMessageId}`);
      let seq = 0;
      const unsub = onValue(r, (snap) => {
        const mySeq = ++seq;
        const raw = (snap.val() as Record<string, DMDbMessage> | null) || {};

        (async () => {
          const list = await Promise.all(
            Object.entries(raw).map(([id, m]) =>
              decodeDmMessage(
                id,
                m,
                (msg) => resolveDmKeyForMessage(msg, user.id, activeDMUserId, "thread"),
                myProfile,
                user.id,
                otherProfile,
                cid,
                "thread"
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
    [user?.id, activeDMUserId, myProfile, otherProfile]
  );

  const sendDirectThreadReply = useCallback(
    async (parentMessageId: string, text: string) => {
      if (!user?.id || !activeDMUserId) throw new Error("Nicht eingeloggt.");
      if (blockedUids.has(activeDMUserId)) {
        showToast("Du hast diese Person blockiert.", "error");
        return;
      }
      const msg = text.trim();
      if (!msg) return;

      const cid = convIdFromIds(user.id, activeDMUserId);
      const createdAt = Date.now();

      const period = await ensureDmPeriodRoot(user.id, activeDMUserId);
      let ciphertext: string, iv: string, ratchetMeta: { periodId?: string; seq?: number };
      if (period) {
        const { key, seq } = await getSendMessageKey(
          cid,
          user.id,
          period.periodId,
          period.rootBytes,
          "thread"
        );
        ({ ciphertext, iv } = await encryptText(key, msg));
        ratchetMeta = { periodId: period.periodId, seq };
      } else {
        const dmKey = await deriveDmKey(user.id, activeDMUserId);
        if (!dmKey) throw new Error("Verschlüsselung nicht verfügbar.");
        ({ ciphertext, iv } = await encryptText(dmKey, msg));
        ratchetMeta = {};
      }

      const signature = await signText(user.id, ciphertext);

      const rRef = push(ref(db, `directThreadReplies/${cid}/${parentMessageId}`));

      try {
        await update(ref(db), {
          [`directThreadReplies/${cid}/${parentMessageId}/${rRef.key}`]: {
            ciphertext,
            iv,
            senderUid: user.id,
            signature,
            createdAt,
            ...ratchetMeta,
          },
          [`rateLimits/${user.id}/lastMessageAt`]: createdAt,
        });
      } catch (e) {
        console.error("[DirectContext] sendDirectThreadReply fehlgeschlagen:", e);
        throw new Error("Senden nicht möglich — evtl. zu schnell hintereinander. Bitte kurz warten und erneut versuchen.");
      }
    },
    [user, activeDMUserId, blockedUids, showToast]
  );

  const deleteDirectThreadReply = useCallback(
    async (parentMessageId: string, replyId: string) => {
      if (!user?.id || !activeDMUserId) throw new Error("Nicht eingeloggt.");
      const cid = convIdFromIds(user.id, activeDMUserId);

      await update(
        ref(db, `directThreadReplies/${cid}/${parentMessageId}/${replyId}`),
        {
          ciphertext: null,
          iv: null,
          signature: null,
          deleted: true,
          deletedAt: Date.now(),
        }
      );
    },
    [user, activeDMUserId]
  );

  /* -----------------------------------------
   * CLEAR DM
   * ---------------------------------------*/
  const clearDM = useCallback(() => {
    setActiveDMUserId(null);
    setActiveDMUser(null);
    setDmMessages([]);

    if (messagesRef.current) {
      off(messagesRef.current);
      messagesRef.current = null;
    }
  }, []);

  const value = useMemo<DirectContextType>(
    () => ({
      activeDMUserId,
      activeDMUser,
      dmMessages,
      dmThreads,
      unreadCounts,
      reactionsByMessage,
      threadCountByMessage,
      threadMessagesByParent,
      startDMWith,
      sendDirectMessage,
      sendDirectSystemMessage,
      editDirectMessage,
      deleteDirectMessage,
      toggleDirectReaction,
      subscribeDirectThread,
      sendDirectThreadReply,
      deleteDirectThreadReply,
      clearDM,
      friends,
      isBlocked,
      blockUser,
      unblockUser,
    }),
    [
      activeDMUserId,
      activeDMUser,
      dmMessages,
      dmThreads,
      unreadCounts,
      reactionsByMessage,
      threadCountByMessage,
      threadMessagesByParent,
      startDMWith,
      sendDirectMessage,
      sendDirectSystemMessage,
      editDirectMessage,
      deleteDirectMessage,
      toggleDirectReaction,
      subscribeDirectThread,
      sendDirectThreadReply,
      deleteDirectThreadReply,
      clearDM,
      friends,
      isBlocked,
      blockUser,
      unblockUser,
    ]
  );

  return (
    <DirectContext.Provider value={value}>{children}</DirectContext.Provider>
  );
}

export function useDirect() {
  const ctx = useContext(DirectContext);
  if (!ctx) throw new Error("useDirect must be used within DirectProvider");
  return ctx;
}
