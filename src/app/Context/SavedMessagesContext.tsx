"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { ref, onValue, off, get, push, set } from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "./UserContext";
import { encryptForSelf, decryptForSelf, type SelfEncrypted } from "@/app/lib/crypto";

export type SavedMessage = {
  id: string;
  text: string;
  senderUid: string;
  senderName: string;
  senderAvatar?: string;
  sourceKind: "channel" | "dm";
  channelId?: string;
  channelName?: string;
  otherUid?: string;
  otherName?: string;
  originalMessageId: string;
  originalCreatedAt: number;
  savedAt: number;
};

type SavedMessageDb = SelfEncrypted & {
  senderUid: string;
  sourceKind: "channel" | "dm";
  channelId?: string;
  otherUid?: string;
  originalMessageId: string;
  originalCreatedAt: number;
  savedAt: number;
};

type SaveParams = {
  text: string;
  senderUid: string;
  sourceKind: "channel" | "dm";
  channelId?: string;
  otherUid?: string;
  originalMessageId: string;
  originalCreatedAt: number;
};

type SavedMessagesContextType = {
  savedMessages: SavedMessage[];
  isSaved: (sourceKind: "channel" | "dm", scopeId: string, messageId: string) => boolean;
  saveMessage: (params: SaveParams) => Promise<void>;
  unsaveMessage: (savedId: string) => Promise<void>;
  loading: boolean;
};

const SavedMessagesContext = createContext<SavedMessagesContextType | undefined>(
  undefined
);

function sourceKey(kind: "channel" | "dm", scopeId: string, messageId: string) {
  return `${kind}:${scopeId}:${messageId}`;
}

export function SavedMessagesProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [savedMessages, setSavedMessages] = useState<SavedMessage[]>([]);
  const [loading, setLoading] = useState(false);

  // Kleine In-Memory-Caches für Anzeige-Metadaten (Name/Avatar), damit nicht
  // bei jedem Snapshot-Update erneut nachgeladen wird — dieselben Nutzer/
  // Channels tauchen typischerweise mehrfach in der Liste auf.
  const userCache = useRef<Map<string, { name: string; avatar?: string }>>(new Map());
  const channelCache = useRef<Map<string, string>>(new Map());

  async function resolveUser(uid: string) {
    const cached = userCache.current.get(uid);
    if (cached) return cached;
    const snap = await get(ref(db, `newusers/${uid}`));
    const v = snap.val() as { newname?: string; avatar?: string } | null;
    const resolved = { name: v?.newname || "Unbekannt", avatar: v?.avatar };
    userCache.current.set(uid, resolved);
    return resolved;
  }

  async function resolveChannelName(channelId: string) {
    const cached = channelCache.current.get(channelId);
    if (cached) return cached;
    const snap = await get(ref(db, `channels/${channelId}/name`));
    const name = (snap.val() as string | null) || "unbekannt";
    channelCache.current.set(channelId, name);
    return name;
  }

  useEffect(() => {
    if (!user?.id) {
      setSavedMessages([]);
      return;
    }
    const uid = user.id;
    const r = ref(db, `savedMessages/${uid}`);
    setLoading(true);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, SavedMessageDb> | null) || {};
      (async () => {
        const entries = await Promise.all(
          Object.entries(raw).map(async ([id, v]) => {
            let text = "🔒 Nicht entschlüsselbar";
            try {
              text = await decryptForSelf(uid, v);
            } catch {
              // bleibt bei der Fehler-Anzeige
            }
            const sender = await resolveUser(v.senderUid);
            const channelName =
              v.sourceKind === "channel" && v.channelId
                ? await resolveChannelName(v.channelId)
                : undefined;
            const other =
              v.sourceKind === "dm" && v.otherUid ? await resolveUser(v.otherUid) : null;

            const entry: SavedMessage = {
              id,
              text,
              senderUid: v.senderUid,
              senderName: sender.name,
              senderAvatar: sender.avatar,
              sourceKind: v.sourceKind,
              channelId: v.channelId,
              channelName,
              otherUid: v.otherUid,
              otherName: other?.name,
              originalMessageId: v.originalMessageId,
              originalCreatedAt: v.originalCreatedAt,
              savedAt: v.savedAt,
            };
            return entry;
          })
        );
        entries.sort((a, b) => b.savedAt - a.savedAt);
        setSavedMessages(entries);
        setLoading(false);
      })();
    });
    return () => off(r, "value", unsub);
  }, [user?.id]);

  const isSaved = (kind: "channel" | "dm", scopeId: string, messageId: string) => {
    const key = sourceKey(kind, scopeId, messageId);
    return savedMessages.some(
      (m) =>
        sourceKey(m.sourceKind, (m.channelId || m.otherUid)!, m.originalMessageId) === key
    );
  };

  const saveMessage = async (params: SaveParams) => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    const payload = await encryptForSelf(user.id, params.text);
    const entryRef = push(ref(db, `savedMessages/${user.id}`));
    const data: SavedMessageDb = {
      ...payload,
      senderUid: params.senderUid,
      sourceKind: params.sourceKind,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.otherUid ? { otherUid: params.otherUid } : {}),
      originalMessageId: params.originalMessageId,
      originalCreatedAt: params.originalCreatedAt,
      savedAt: Date.now(),
    };
    await set(entryRef, data);
  };

  const unsaveMessage = async (savedId: string) => {
    if (!user?.id) return;
    await set(ref(db, `savedMessages/${user.id}/${savedId}`), null);
  };

  return (
    <SavedMessagesContext.Provider
      value={{ savedMessages, isSaved, saveMessage, unsaveMessage, loading }}
    >
      {children}
    </SavedMessagesContext.Provider>
  );
}

export function useSavedMessages() {
  const ctx = useContext(SavedMessagesContext);
  if (!ctx)
    throw new Error("useSavedMessages must be used within a SavedMessagesProvider");
  return ctx;
}
