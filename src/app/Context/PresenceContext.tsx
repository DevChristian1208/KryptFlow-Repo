"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { ref, onValue, onDisconnect, set, serverTimestamp } from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "./UserContext";

type PresenceContextType = {
  onlineUids: Record<string, boolean>;
  signOutPresence: () => Promise<void>;
};

const PresenceContext = createContext<PresenceContextType | undefined>(undefined);

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [onlineUids, setOnlineUids] = useState<Record<string, boolean>>({});
  const connectedUnsub = useRef<(() => void) | null>(null);
  const myUidRef = useRef<string | null>(null);

  useEffect(() => {
    myUidRef.current = user?.id ?? null;
  }, [user?.id]);

  useEffect(() => {
    if (connectedUnsub.current) {
      connectedUnsub.current();
      connectedUnsub.current = null;
    }
    if (!user?.id) return;

    const myPresenceRef = ref(db, `presence/${user.id}`);
    const connectedRef = ref(db, ".info/connected");

    const unsub = onValue(connectedRef, (snap) => {
      if (snap.val() !== true) return;
      onDisconnect(myPresenceRef)
        .set({ state: "offline", lastChanged: serverTimestamp() })
        .then(() => {
          set(myPresenceRef, { state: "online", lastChanged: serverTimestamp() });
        });
    });

    connectedUnsub.current = () => unsub();
    return () => {
      if (connectedUnsub.current) {
        connectedUnsub.current();
        connectedUnsub.current = null;
      }
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setOnlineUids({});
      return;
    }

    const r = ref(db, "presence");
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, { state?: string }> | null) || {};
      const online: Record<string, boolean> = {};
      for (const [uid, v] of Object.entries(raw)) {
        if (v?.state === "online") online[uid] = true;
      }
      setOnlineUids(online);
    });

    return () => unsub();
  }, [user?.id]);

  const signOutPresence = async () => {
    const uid = myUidRef.current;
    if (!uid) return;
    try {
      const myPresenceRef = ref(db, `presence/${uid}`);
      await onDisconnect(myPresenceRef).cancel();
      await set(myPresenceRef, { state: "offline", lastChanged: serverTimestamp() });
    } catch {
      // Fallback: onDisconnect-Hook übernimmt beim tatsächlichen Verbindungsabbruch
    }
  };

  return (
    <PresenceContext.Provider value={{ onlineUids, signOutPresence }}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence() {
  const ctx = useContext(PresenceContext);
  if (!ctx) throw new Error("usePresence must be used within PresenceProvider");
  return ctx;
}
