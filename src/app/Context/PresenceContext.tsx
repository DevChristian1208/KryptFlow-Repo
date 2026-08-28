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

  // Eigene Präsenz melden: bei jedem (Re-)Connect wird der eigene Status auf
  // "online" gesetzt und gleichzeitig ein onDisconnect-Hook hinterlegt, der
  // ihn serverseitig auf "offline" umschaltet, sobald die Verbindung abreißt
  // (Tab schließen, Netzwerkausfall, Absturz) — funktioniert auch, wenn der
  // Client keinen sauberen Logout durchführt.
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

  // Präsenz aller Nutzer live mitlesen
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

  // Vor einem bewussten Logout aufzurufen: hebt den onDisconnect-Hook auf
  // (der sonst später ohnehin "offline" schreiben würde) und setzt die
  // Präsenz sofort selbst zurück — ohne das bleibt man für andere "online",
  // solange der RTDB-Socket dieses Tabs offen bleibt (z. B. bei einem reinen
  // Client-seitigen Redirect nach /Login ohne echten Verbindungsabbruch).
  const signOutPresence = async () => {
    const uid = myUidRef.current;
    if (!uid) return;
    try {
      const myPresenceRef = ref(db, `presence/${uid}`);
      await onDisconnect(myPresenceRef).cancel();
      await set(myPresenceRef, { state: "offline", lastChanged: serverTimestamp() });
    } catch {
      // Bestmögliche Anstrengung — beim tatsächlichen Verbindungsabbruch
      // greift ohnehin noch der onDisconnect-Hook als Fallback.
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
