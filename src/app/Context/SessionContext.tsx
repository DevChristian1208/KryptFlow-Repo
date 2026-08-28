"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ref, onValue, set, update, remove, serverTimestamp } from "firebase/database";
import { signOut } from "firebase/auth";
import { db, auth } from "@/app/lib/firebase";
import { useUser } from "./UserContext";
import { useToast } from "./ToastContext";

export type SessionInfo = {
  id: string;
  userAgent?: string;
  createdAt?: number;
  lastSeenAt?: number;
};

type SessionContextType = {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  endSession: (sessionId: string) => Promise<void>;
  endCurrentSession: () => Promise<void>;
};

const SessionContext = createContext<SessionContextType | undefined>(undefined);

const HEARTBEAT_MS = 5 * 60 * 1000;

function getOrCreateSessionId(): string {
  const key = "cryptflow_session_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const { showToast } = useToast();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const selfDestructedRef = useRef(false);

  // Eigene Sitzung anlegen/aktualisieren + Heartbeat.
  useEffect(() => {
    if (!user?.id) {
      setCurrentSessionId(null);
      return;
    }

    const sessionId = getOrCreateSessionId();
    setCurrentSessionId(sessionId);
    selfDestructedRef.current = false;

    const myRef = ref(db, `sessions/${user.id}/${sessionId}`);
    set(myRef, {
      userAgent: navigator.userAgent,
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    }).catch(() => {});

    const heartbeat = setInterval(() => {
      update(myRef, { lastSeenAt: serverTimestamp() }).catch(() => {});
    }, HEARTBEAT_MS);

    // Wird dieser Sitzungs-Knoten von einem anderen Gerät aus gelöscht
    // (Settings -> Sitzungen -> "Abmelden"), meldet sich dieser Tab selbst
    // ab — echte (near-realtime) Remote-Abmeldung ohne eigenes Backend.
    const unsub = onValue(myRef, (snap) => {
      if (!snap.exists() && !selfDestructedRef.current) {
        selfDestructedRef.current = true;
        showToast("Diese Sitzung wurde von einem anderen Gerät beendet.", "info");
        signOut(auth).finally(() => router.push("/Login"));
      }
    });

    return () => {
      clearInterval(heartbeat);
      unsub();
    };
  }, [user?.id, router, showToast]);

  // Alle eigenen Sitzungen live mitlesen (für die Settings-Übersicht).
  useEffect(() => {
    if (!user?.id) {
      setSessions([]);
      return;
    }
    const r = ref(db, `sessions/${user.id}`);
    const unsub = onValue(r, (snap) => {
      const raw = (snap.val() as Record<string, Omit<SessionInfo, "id">> | null) || {};
      const list = Object.entries(raw).map(([id, v]) => ({ id, ...v }));
      list.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
      setSessions(list);
    });
    return () => unsub();
  }, [user?.id]);

  const endSession = async (sessionId: string) => {
    if (!user?.id) return;
    await remove(ref(db, `sessions/${user.id}/${sessionId}`));
  };

  // Für den bewussten eigenen Logout (Header): markiert selfDestructedRef
  // VOR dem Löschen, damit der onValue-Listener oben das nicht fälschlich
  // als Fremd-Abmeldung interpretiert und den "von einem anderen Gerät
  // beendet"-Toast zeigt.
  const endCurrentSession = async () => {
    if (!user?.id || !currentSessionId) return;
    selfDestructedRef.current = true;
    await remove(ref(db, `sessions/${user.id}/${currentSessionId}`)).catch(() => {});
  };

  return (
    <SessionContext.Provider
      value={{ sessions, currentSessionId, endSession, endCurrentSession }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
