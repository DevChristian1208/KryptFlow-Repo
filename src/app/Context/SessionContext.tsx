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
import { ref, onValue, off, set, update, remove, serverTimestamp } from "firebase/database";
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
  staySignedIn: boolean;
  setStaySignedIn: (value: boolean) => Promise<void>;
};

const SessionContext = createContext<SessionContextType | undefined>(undefined);

const HEARTBEAT_MS = 5 * 60 * 1000;

// Standardverhalten: automatische Abmeldung nach Inaktivität — wer das
// nicht will, kann in den Einstellungen "Dauerhaft angemeldet bleiben"
// aktivieren (newusers/{uid}/staySignedIn), das schaltet den Timer für
// diesen Account komplett ab.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;

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
  const [staySignedIn, setStaySignedInState] = useState(false);
  const selfDestructedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());

  // Eigene Präferenz live mitlesen — reagiert sofort, falls in einem
  // anderen Tab/Gerät geändert, ohne dass ein Neu-Login nötig wäre.
  useEffect(() => {
    if (!user?.id) {
      setStaySignedInState(false);
      return;
    }
    const r = ref(db, `newusers/${user.id}/staySignedIn`);
    const unsub = onValue(r, (snap) => setStaySignedInState(snap.val() === true));
    return () => off(r, "value", unsub);
  }, [user?.id]);

  const setStaySignedIn = async (value: boolean) => {
    if (!user?.id) return;
    await update(ref(db, `newusers/${user.id}`), { staySignedIn: value });
  };

  // Automatische Abmeldung nach Inaktivität — der Standard, den es vorher
  // gar nicht gab (Firebase Auth hält Logins sonst unbegrenzt aufrecht).
  // Aktivität wird zusätzlich in localStorage gespiegelt (mit einfachem
  // Zeit-Throttle, kein Schreiben bei jeder Mausbewegung): Firebase Auth
  // ist pro Origin tab-übergreifend gemeinsam angemeldet, ein rein
  // lokaler In-Memory-Timer würde also bei mehreren offenen Tabs (z. B.
  // Test-Setup mit zwei Accounts) einen inaktiven Hintergrund-Tab den
  // gerade aktiv genutzten Tab mit-abmelden lassen.
  useEffect(() => {
    if (!user?.id || staySignedIn) return;

    const STORAGE_KEY = "cryptflow_last_activity";
    const now = Date.now();
    lastActivityRef.current = now;
    localStorage.setItem(STORAGE_KEY, String(now));

    const onActivity = () => {
      const t = Date.now();
      if (t - lastActivityRef.current < 5000) return;
      lastActivityRef.current = t;
      localStorage.setItem(STORAGE_KEY, String(t));
    };
    ACTIVITY_EVENTS.forEach((ev) =>
      window.addEventListener(ev, onActivity, { passive: true })
    );

    const check = setInterval(() => {
      const stored = Number(localStorage.getItem(STORAGE_KEY)) || lastActivityRef.current;
      const lastActivity = Math.max(stored, lastActivityRef.current);
      if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
        clearInterval(check);
        showToast("Du wurdest wegen Inaktivität abgemeldet.", "info");
        signOut(auth).finally(() => router.push("/Login"));
      }
    }, IDLE_CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
      clearInterval(check);
    };
  }, [user?.id, staySignedIn, router, showToast]);

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
      value={{
        sessions,
        currentSessionId,
        endSession,
        endCurrentSession,
        staySignedIn,
        setStaySignedIn,
      }}
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
