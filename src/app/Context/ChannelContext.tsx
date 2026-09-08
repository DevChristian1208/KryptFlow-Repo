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

// Perioden-Rekeying für Channels: alle 24h ein frischer Channel-Key
// (Forward Secrecy — ein kompromittierter Schlüssel legt nur die aktuelle
// Periode offen, nicht die komplette Historie). Pro-Nachricht-Ratchet ist
// für Gruppen bewusst nicht umgesetzt (bräuchte ein eigenes Sender-Key-
// Schema, siehe Plan) — DMs haben stattdessen einen echten Ratchet
// (DirectContext.tsx).
const CHANNEL_EPOCH_DURATION_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------
// TYPES
// ---------------------------------------------------

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
  // Legacy-Felder aus der Zeit vor der Verschlüsselungs-Umstellung:
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
  /** Nur bei DMs: Einladungskarte statt normalem Text (siehe DirectContext). */
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

/**
 * Entschlüsselt+verifiziert eine einzelne Nachricht (Haupt-Channel oder
 * Thread-Antwort — gleiche Struktur). Wird von mehreren Stellen
 * wiederverwendet, damit die Logik nicht dupliziert wird.
 */
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

  // Alte, unverschlüsselte Nachrichten aus der Zeit vor der Umstellung
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

// ---------------------------------------------------
// Warten bis Auth bereit ist
// ---------------------------------------------------
function useAuthReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, () => setReady(true));
    return () => unsub();
  }, []);
  return ready;
}

// ---------------------------------------------------
// PROVIDER
// ---------------------------------------------------
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
        // Schlüssel-Backup kann das eigene Gerät den EIGENEN alten Legacy-Key
        // nicht mehr entschlüsseln — Selbstheilung ist hier unmöglich (siehe
        // keyVersion-Reparatur oben), nur ein anderes, noch gültiges
        // Mitglied kann den Envelope neu wrappen. Kein console.error, damit
        // dieser für den Nutzer nicht reparierbare Fall nicht wie ein Absturz
        // aussieht.
        console.debug("[ChannelContext] Eigener Legacy-Channel-Key nicht entschlüsselbar (vermutlich alter Schlüssel vor Geräte-/Origin-Wechsel):", e);
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
        console.debug("[ChannelContext] Eigener Epochen-Key nicht entschlüsselbar (vermutlich alter Schlüssel vor Geräte-/Origin-Wechsel):", e);
        return null;
      }
    },
    [user?.id]
  );

  /**
   * Erzeugt (falls noch niemand das getan hat) den Channel-Key für eine
   * Perioden-Epoche und wrapt ihn für alle übergebenen Mitglieder — per
   * Firebase-Transaction atomar "beansprucht", damit zwei gleichzeitig
   * aktive Clients nicht mit unterschiedlichen Schlüsseln für dieselbe
   * Epoche kollidieren (siehe Plan: Race-Auflösung ohne Custom-Krypto-Risiko).
   */
  const claimChannelEpoch = useCallback(
    async (channelId: string, epochId: string, memberUids: string[]) => {
      const nodeRef = ref(db, `channelKeyEpochs/${channelId}/${epochId}`);
      const existing = await get(nodeRef);
      if (existing.exists()) return;

      const channelKey = await generateChannelKey();
      const envelopes: Record<string, ChannelKeyEnvelope> = {};
      for (const uid of memberUids) {
        // bypassCache: das Anlegen einer Epoche passiert selten (max. 1x pro
        // Kanal/Tag) — die minimale Extra-Latenz hier ist es wert, damit ein
        // bis zu 60s alter zwischengespeicherter Public Key (siehe
        // PUBLIC_KEY_CACHE_TTL_MS) niemals dazu führt, dass ausgerechnet der
        // Envelope für ein gerade erst (neu) veröffentlichtes Mitglied —
        // ggf. sogar für einen selbst — gegen den falschen Schlüssel
        // gewrappt wird und damit für immer unentschlüsselbar bliebe.
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

  // -------------------------------------------------------
  //  Auto-Member: Nutzer in alle Channels aufnehmen + fehlende
  //  Channel-Key-Envelopes (Legacy + alle Perioden-Epochen) für andere
  //  Mitglieder nachliefern
  // -------------------------------------------------------
  const ensureUserInAllChannels = useCallback(async () => {
    if (!user?.id || servers.length === 0) return;

    try {
      const myServerIds = new Set(servers.map((s) => s.id));
      const chansSnap = await get(ref(db, "channels"));
      const chans = (chansSnap.val() || {}) as Record<string, ChannelDb>;
      const relevantEntries = Object.entries(chans).filter(
        ([, chan]) => chan.serverId && myServerIds.has(chan.serverId)
      );

      // Server-Mitgliederlisten vorab EINMAL pro Server parallel laden
      // (statt verschachtelt pro Kanal sequenziell) — mehrere Kanäle
      // desselben Servers teilen sich denselben Fetch.
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

      // Mitgliedschaft selbst wird hier bewusst NICHT vergeben — bei
      // eingeschränkten Kanälen läuft Beitritt ausschließlich über eine
      // angenommene Einladung (channelInvites, siehe acceptChannelInvite)
      // oder als Ersteller; bei nicht-eingeschränkten Kanälen ergibt sich
      // die Zugriffsberechtigung bereits aus der Server-Mitgliedschaft
      // (siehe Rules). Diese Funktion liefert nur fehlende Schlüssel-
      // Envelopes nach — bei nicht-eingeschränkten Kanälen für ALLE
      // aktuellen Server-Mitglieder, bei eingeschränkten nur für die
      // explizit eingetragenen.
      //
      // Alle Kanäle laufen parallel statt nacheinander: bei mehreren
      // Servern/Kanälen sammelte sich hier sonst schnell ein Vielfaches an
      // sequenziellen Firebase-Roundtrips an — genau die Zeit, die einem
      // gerade beigetretenen Mitglied fehlt, dessen sendMessage() nur ein
      // kurzes Zeitfenster auf genau diesen Nachlieferungs-Lauf wartet
      // (siehe getCurrentChannelEpochKey).
      await Promise.all(
        relevantEntries.map(async ([cid, chan]) => {
          let memberUids: string[];
          if (chan.restricted) {
            if (!chan.members?.[user.id]) return;
            memberUids = Object.keys({ ...(chan.members || {}), [user.id]: true });
          } else {
            memberUids = serverMembersCache.get(chan.serverId!) || [];
          }

          // Legacy (flacher, dauerhafter) Channel-Key — bleibt für Alt-
          // Nachrichten ohne epochId als Fallback bestehen.
          const channelKey = await getOwnChannelKey(cid);
          if (channelKey) {
            const keysSnap = await get(ref(db, `channelKeys/${cid}`));
            const existingKeys =
              (keysSnap.val() as Record<string, ChannelKeyEnvelope> | null) || {};
            await Promise.all(
              memberUids.map(async (uid) => {
                const existing = existingKeys[uid];
                // Nicht nur "fehlt komplett", sondern auch "ist für ein
                // inzwischen ersetztes Schlüsselpaar gewrappt" nachliefern —
                // sonst bleibt ein Mitglied nach einem Origin-/Geräte-Wechsel
                // (neues Schlüsselpaar, siehe ensureIdentityKeys) dauerhaft
                // mit einem für sich selbst unentschlüsselbaren Envelope stehen.
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

          // Perioden-Epochen: fehlende Envelopes für alle bereits
          // existierenden Epochen nachliefern (nur möglich, wenn man selbst
          // schon einen gültigen Envelope für diese Epoche hat), plus die
          // aktuelle Epoche anlegen, falls sie noch gar nicht existiert.
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

  /**
   * Löst den Schlüssel für eine Nachricht auf: mit `epochId` wird die
   * passende Perioden-Epoche geholt, ohne `epochId` (Alt-Nachrichten von
   * vor dieser Umstellung) greift der bisherige flache Channel-Key.
   */
  const resolveChannelKey = useCallback(
    (channelId: string, epochId?: string): Promise<CryptoKey | null> =>
      epochId
        ? getOwnChannelEpochKey(channelId, epochId)
        : getOwnChannelKey(channelId),
    [getOwnChannelEpochKey, getOwnChannelKey]
  );

  /** Aktuell nutzbarer Epochen-Schlüssel für neue, ausgehende Nachrichten
   * (erzeugt die Epoche bei Bedarf, statt nur zu warten). */
  const getCurrentChannelEpochKey = useCallback(
    async (channelId: string): Promise<{ epochId: string; key: CryptoKey } | null> => {
      const epochId = epochIdForTimestamp(CHANNEL_EPOCH_DURATION_MS);
      let key = await getOwnChannelEpochKey(channelId, epochId);
      if (!key) {
        // Gleiche Mitgliederquelle wie in ensureUserInAllChannels: bei
        // nicht-eingeschränkten Kanälen ist channels/{id}/members oft nur
        // mit dem Ersteller gefüllt (Zugriff ergibt sich sonst allein aus
        // der Server-Mitgliedschaft) — würde man hier trotzdem nur diese
        // Liste zum Umschlag-Wrappen benutzen, bekäme bei einem
        // Epochenwechsel nur der Ersteller einen gültigen Envelope, die
        // per Transaction "beanspruchte" Epoche ließe sich danach nicht
        // mehr korrigieren, und jedes andere Mitglied bliebe dauerhaft
        // ohne Schlüssel für diese Epoche.
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
        // bricht dann sofort ab (niemand überschreibt eine bestehende
        // Epoche). Ohne fremde Hilfe (jemand mit gültigem Zugriff, dessen
        // Client ensureUserInAllChannels erneut durchläuft) lässt sich das
        // aus der eigenen Sitzung heraus nicht direkt reparieren — aber
        // genau das passiert oft binnen Sekunden von selbst, sobald ein
        // anderes, bereits eingeweihtes Mitglied gerade online ist/die App
        // öffnet. Ein paar Mal kurz erneut nachsehen, bevor endgültig
        // aufgegeben wird, macht diesen häufigen Fall für den Nutzer
        // unsichtbar, statt sofort einen Fehler zu zeigen.
        for (let attempt = 0; !key && attempt < 15; attempt++) {
          await new Promise((r) => setTimeout(r, 1200));
          key = await getOwnChannelEpochKey(channelId, epochId);
        }
      }
      return key ? { epochId, key } : null;
    },
    [user, getOwnChannelEpochKey, claimChannelEpoch]
  );

  // Läuft nicht nur einmal beim Login, sondern bei jeder Änderung am
  // channels-Baum erneut — so liefert JEDES bereits eingeweihte, gerade
  // geöffnete Mitglied fehlende Channel-Key-Envelopes nach, sobald ein
  // neues Mitglied auftaucht, statt dass Neue bis zu einem Reload eines
  // anderen Mitglieds ohne Schlüssel dastehen. ensureUserInAllChannels ist
  // idempotent (überspringt bereits vorhandene Mitgliedschaften/Envelopes).
  useEffect(() => {
    if (!authReady || !user?.id) return;
    const r = ref(db, "channels");
    const unsub = onValue(r, () => {
      ensureUserInAllChannels();
    });
    return () => unsub();
  }, [authReady, user?.id, ensureUserInAllChannels]);

  // Tritt jemand einem Server bei (nicht-eingeschränkte Kanäle: Zugriff
  // ergibt sich allein aus der Server-Mitgliedschaft), ändert sich dabei nur
  // serverMembers/userServers — NICHT channels. Ohne diesen zusätzlichen
  // Listener würden bereits geöffnete, andere Mitglieder das neue Mitglied
  // nie bemerken und ihm keinen Channel-Key-Envelope nachliefern, bis
  // zufällig mal etwas an channels selbst geändert wird oder sie neu laden.
  useEffect(() => {
    if (!authReady || !user?.id || servers.length === 0) return;
    const unsubs = servers.map((s) =>
      onValue(ref(db, `serverMembers/${s.id}`), () => {
        ensureUserInAllChannels();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [authReady, user?.id, servers, ensureUserInAllChannels]);

  // ---------------------------------------------------
  // CHANNELS LADEN
  // ---------------------------------------------------
  useEffect(() => {
    if (!authReady || !user?.id || !activeServerId) {
      setChannels([]);
      return;
    }

    const r = ref(db, "channels");

    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() || {}) as Record<string, ChannelDb>;

      // Sichtbar sind: alle nicht-eingeschränkten Kanäle des aktiven Servers
      // (Server-Mitgliedschaft reicht, keine einzelne Einladung nötig — echtes
      // Discord-Verhalten) sowie eingeschränkte Kanäle, in denen man explizit
      // Mitglied ist (weiterhin über channelInvites/MembersModal gesteuert).
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

  // ---------------------------------------------------
  // AKTIVE CHANNEL-MITGLIEDER (live Mitgliedschaft, Namen/Avatare
  // einmalig aufgelöst) — wird sowohl für die Mitglieder-Anzeige als
  // auch für die @-Erwähnungs-Autovervollständigung verwendet.
  // ---------------------------------------------------
  useEffect(() => {
    setChannelMembers([]);
    if (!activeChannelId || !activeChannel) return;

    // Bei eingeschränkten Channels ergibt sich die Mitgliederliste aus der
    // expliziten members-Map dort; bei offenen Channels dagegen aus ALLEN
    // Server-Mitgliedern (channels/{id}/members enthält dort meist nur den
    // Ersteller, siehe ensureUserInAllChannels — Zugriff läuft für alle
    // anderen über die Server-Mitgliedschaft, nicht über diese Map). Ohne
    // diese Unterscheidung zeigte die Mitgliederliste offener Channels
    // fälschlich nur den Ersteller statt aller tatsächlichen Mitglieder.
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

  // ---------------------------------------------------
  // ANGEHEFTETE NACHRICHTEN
  // ---------------------------------------------------
  useEffect(() => {
    setPinnedMessageIds(new Set());
    if (!activeChannelId) return;
    const r = ref(db, `channelPins/${activeChannelId}`);
    const unsub = onValue(r, (snap) => {
      setPinnedMessageIds(new Set(Object.keys((snap.val() as Record<string, unknown>) || {})));
    });
    return () => unsub();
  }, [activeChannelId]);

  // ---------------------------------------------------
  // TIPP-INDIKATOR — kein RTDB-TTL vorhanden, daher clientseitig veraltete
  // (>6s alte) Einträge herausfiltern; der Schreiber selbst räumt seinen
  // eigenen Eintrag zusätzlich per onDisconnect + Timeout auf (siehe
  // notifyTyping unten).
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // CHANNEL-MESSAGES LADEN, ENTSCHLÜSSELN, VERIFIZIEREN
  // ---------------------------------------------------
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
        // Nur übernehmen, falls kein neuerer Snapshot inzwischen eingetroffen
        // ist (verhindert, dass eine langsamere ältere Entschlüsselung eine
        // bereits aktuellere Liste überschreibt).
        if (mySeq === seq) setMessages(list);
      })();
    });

    return () => unsub();
  }, [activeChannelId, user?.id, resolveChannelKey, resolveProfile]);

  // ---------------------------------------------------
  // Reaktionen & Thread-Zähler: pro sichtbarer Nachricht
  // ---------------------------------------------------
  useEffect(() => {
    // Channel gewechselt: alle bisherigen Listener + gecachten Zustand verwerfen
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
  }, [activeChannelId, messages, resolveChannelKey]);

  // ---------------------------------------------------
  // UMFRAGE-STIMMEN LIVE MITLESEN — exakt dasselbe Muster wie Reaktionen
  // oben: pro Nachricht ein Listener auf channelPollVotes/{channelId}/{id},
  // jede Stimme trägt ihre eigene epochId (unabhängig von der Epoche der
  // Umfrage-Nachricht selbst, genau wie bei Reaktionen).
  // ---------------------------------------------------
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
              // nicht entschlüsselbare Stimme überspringen
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

  // ---------------------------------------------------
  // CHANNEL ERSTELLEN
  // ---------------------------------------------------
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
      // die Regel erzwingen kann, dass beide zusammengehören (verhindert,
      // dass ein Client die Drosselung durch Auslassen des Zeitstempels
      // umgeht — siehe database.rules.json). Mitglied wird hier bewusst
      // NUR der Ersteller: bei nicht-eingeschränkten Kanälen ergibt sich der
      // Zugriff für alle anderen aus der Server-Mitgliedschaft (Rules),
      // eingeschränkte Kanäle laufen über das Einladungssystem
      // (channelInvites, siehe inviteToChannel).
      //
      // skipRateLimit: beim Anlegen mehrerer Startkanäle direkt bei der
      // Server-Erstellung (siehe CreateOrJoinServerModal) würde die normale
      // 5s-Drossel jeden Kanal außer dem ersten blockieren — die Regel
      // verknüpft channels/{id} nicht zwingend mit dem Zeitstempel, daher
      // ist das Auslassen hier unschädlich.
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

  // ---------------------------------------------------
  // @-ERWÄHNUNGEN: Benachrichtigungs-Fanout (unverschlüsselte Metadaten,
  // kein Nachrichteninhalt — siehe channelMentions in database.rules.json)
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // MESSAGE SENDEN: verschlüsseln + signieren
  // ---------------------------------------------------
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
      // Nachricht + Rate-Limit-Zeitstempel atomar in einem Aufruf (siehe
      // database.rules.json: die Regel erzwingt, dass beide zusammenpassen).
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

  // ---------------------------------------------------
  // NACHRICHT BEARBEITEN
  // ---------------------------------------------------
  const editMessage = async (messageId: string, newText: string) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    if (!activeChannelId) throw new Error("Kein Channel aktiv.");

    const text = newText.trim();
    if (!text) return;

    // Mit demselben Schlüssel neu verschlüsseln, mit dem die Nachricht
    // ursprünglich stand — ihr gespeichertes epochId-Feld bleibt beim
    // Bearbeiten unverändert, die Verschlüsselung muss also zur selben
    // (ggf. inzwischen nicht mehr aktuellen) Periode passen.
    const existing = messages.find((m) => m.id === messageId);
    const channelKey = await resolveChannelKey(activeChannelId, existing?.epochId);
    if (!channelKey) throw new Error("Kein Verschlüsselungs-Schlüssel verfügbar.");

    const { ciphertext, iv } = await encryptText(channelKey, text);
    const signature = await signText(user.id, ciphertext);

    // Alte Fassung vor dem Überschreiben als Historien-Eintrag sichern.
    // `messages` enthält nur den bereits entschlüsselten Text, nicht das
    // rohe Chiffrat — deshalb hier separat aus Firebase nachladen. Eigener
    // Aufruf statt im selben Mehrfach-Schreibvorgang wie die eigentliche
    // Bearbeitung: der Historien-Pfad ist write-once (siehe Rules), ein
    // Fehlschlag dabei soll die eigentliche Bearbeitung nicht blockieren.
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

  // ---------------------------------------------------
  // NACHRICHT LÖSCHEN (Soft-Delete/Tombstone)
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // NACHRICHT ANHEFTEN/LÖSEN (Owner/Admin)
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // BEARBEITUNGS-HISTORIE EINER NACHRICHT LADEN + ENTSCHLÜSSELN — dieselbe
  // epochId wie die aktuelle Fassung, editMessage ändert sie nie.
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // TIPP-INDIKATOR AUSLÖSEN — höchstens alle 3s ein Schreibzugriff; der
  // eigene Eintrag räumt sich selbst nach 5s auf (kein RTDB-TTL verfügbar)
  // und zusätzlich sofort per onDisconnect bei Verbindungsabbruch.
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // THREAD-ANTWORT LÖSCHEN (Soft-Delete/Tombstone)
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // REAKTION TOGGELN (ein aktiver Slot pro Nutzer/Nachricht)
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // UMFRAGE-STIMME ABGEBEN (ein aktiver Slot pro Nutzer/Nachricht, wie bei
  // Reaktionen) — der Optionsindex selbst wird verschlüsselt gespeichert,
  // damit auch bei Umfragen nirgends Klartext auf dem Server landet.
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // THREAD-ANTWORTEN
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // PERSON ZU CHANNEL EINLADEN (Annahme/Ablehnung: NotificationContext)
  // ---------------------------------------------------
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

  // ---------------------------------------------------
  // KANAL ALS EINGESCHRÄNKT MARKIEREN/AUFHEBEN (Owner/Admin)
  // ---------------------------------------------------
  const setChannelRestricted = async (channelId: string, restricted: boolean) => {
    try {
      await update(ref(db, `channels/${channelId}`), { restricted });
    } catch (e) {
      console.error("[ChannelContext] setChannelRestricted fehlgeschlagen:", e);
      throw new Error("Kanal-Einstellung konnte nicht geändert werden.");
    }
  };

  // ---------------------------------------------------
  // KANAL ALS ANKÜNDIGUNGS-KANAL MARKIEREN/AUFHEBEN (Owner/Admin) —
  // unabhängig von "restricted": steuert WER SCHREIBEN darf (alle lesenden
  // Mitglieder vs. nur Owner/Admin), nicht WER DEN KANAL SEHEN darf.
  // ---------------------------------------------------
  const setChannelAnnouncementOnly = async (channelId: string, announcementOnly: boolean) => {
    try {
      await update(ref(db, `channels/${channelId}`), { announcementOnly });
    } catch (e) {
      console.error("[ChannelContext] setChannelAnnouncementOnly fehlgeschlagen:", e);
      throw new Error("Kanal-Einstellung konnte nicht geändert werden.");
    }
  };

  // ---------------------------------------------------
  // KANAL LÖSCHEN (Owner/Admin) — erst die Blätter (Nachrichten/Schlüssel),
  // dann den Kanal selbst, in getrennten Aufrufen: channelKeys/-Epochs' Rule
  // liest channels/{id}.serverId, das darf im selben Mehrfach-
  // Schreibvorgang, in dem channels/{id} mitgelöscht würde, nicht schon weg
  // sein (Cross-Path-Problem, siehe deleteServer in ServerContext.tsx).
  // ---------------------------------------------------
  const deleteChannel = async (channelId: string) => {
    try {
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
