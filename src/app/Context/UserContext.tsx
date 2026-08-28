"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { onAuthStateChanged, User as FirebaseUser } from "firebase/auth";
import { ref, get } from "firebase/database";
import { auth, db } from "@/app/lib/firebase";
import { ensureIdentityKeys } from "@/app/lib/crypto";

export type User = {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  isGuest: boolean;
};

type UserContextType = {
  user: User | null;
  setUser: (u: User | null) => void;
  loading: boolean;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(
      auth,
      async (authUser: FirebaseUser | null) => {
        if (!authUser) {
          setUser(null);
          setLoading(false);
          return;
        }

        try {
          await ensureIdentityKeys(authUser.uid);

          const newUserSnap = await get(ref(db, `newusers/${authUser.uid}`));
          if (newUserSnap.exists()) {
            const u = newUserSnap.val();
            const registeredUser: User = {
              id: authUser.uid,
              name: u.newname || "Unbekannt",
              email: u.newemail || authUser.email || "",
              avatar: u.avatar || "/avatar1.png",
              isGuest: !!u.isGuest,
            };

            setUser(registeredUser);
            setLoading(false);
            return;
          }

          // Fallback: Auth-Konto existiert, aber es wurde noch kein
          // Profil unter newusers/ angelegt (z. B. frischer Gast vor
          // Abschluss der Avatar-Auswahl).
          const fallbackUser: User = {
            id: authUser.uid,
            name: authUser.isAnonymous
              ? "Gast"
              : authUser.displayName || authUser.email || "Nutzer",
            email: authUser.email || "",
            avatar: "/avatar1.png",
            isGuest: authUser.isAnonymous,
          };

          setUser(fallbackUser);
          setLoading(false);
        } catch (err) {
          console.error("Fehler beim Laden des Nutzers:", err);
          setUser(null);
          setLoading(false);
        }
      }
    );

    return () => unsub();
  }, []);

  return (
    <UserContext.Provider value={{ user, setUser, loading }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within a UserProvider");
  return ctx;
}
