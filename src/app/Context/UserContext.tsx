"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { onAuthStateChanged, User as FirebaseUser } from "firebase/auth";
import { ref, get } from "firebase/database";
import { auth, db } from "@/app/lib/firebase";
import {
  ensureIdentityKeys,
  ensureIdentityAndAutoBackup,
  needsIdentityRecoveryPrompt,
} from "@/app/lib/crypto";
import { consumePendingLoginPassword } from "@/app/lib/pendingLoginPassword";
import { ensureHomeServerBootstrapped } from "@/app/lib/homeServer";
import IdentityRecoveryModal from "@/app/Dashboard/Components/IdentityRecoveryModal";

export type User = {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  isGuest: boolean;
  emailVerified?: boolean;
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
  const [recoveryUid, setRecoveryUid] = useState<string | null>(null);
  const recoveryResolveRef = useRef<(() => void) | null>(null);
  // Firebase kann onAuthStateChanged bei EINEM Login mehrfach kurz
  // hintereinander auslösen (z. B. initialer Zustand + Token-Refresh kurz
  // nach dem Sign-in). Ohne Absicherung würde ein zweites, praktisch
  // gleichzeitiges Auslösen das (Einmal-)Passwort bereits verbraucht
  // vorfinden, während die erste Wiederherstellung noch läuft — hält die
  // lokale Identität dann fälschlich für fehlend und kann eine zweite,
  // unabhängige (neue) Identität anstoßen. Dieser Ref sorgt dafür, dass die
  // Einrichtung pro uid nur einmal läuft; weitere Auslösungen warten auf
  // dieselbe laufende Zusage, statt eigenständig zu entscheiden.
  const identitySetupRef = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    const unsub = onAuthStateChanged(
      auth,
      async (authUser: FirebaseUser | null) => {
        if (!authUser) {
          identitySetupRef.current.clear();
          setUser(null);
          setLoading(false);
          return;
        }

        try {
          let setupPromise = identitySetupRef.current.get(authUser.uid);
          if (!setupPromise) {
            setupPromise = (async () => {
              const pendingPassword = consumePendingLoginPassword();
              if (pendingPassword) {
                await ensureIdentityAndAutoBackup(authUser.uid, pendingPassword);
              } else {
                if (await needsIdentityRecoveryPrompt(authUser.uid)) {
                  await new Promise<void>((resolve) => {
                    setRecoveryUid(authUser.uid);
                    recoveryResolveRef.current = resolve;
                  });
                }
                await ensureIdentityKeys(authUser.uid);
              }
            })();
            identitySetupRef.current.set(authUser.uid, setupPromise);
          }
          await setupPromise;
          ensureHomeServerBootstrapped(authUser.uid, authUser.email).catch((e) =>
            console.error("[UserContext] HomeServer-Bootstrap fehlgeschlagen:", e)
          );

          const newUserSnap = await get(ref(db, `newusers/${authUser.uid}`));
          if (newUserSnap.exists()) {
            const u = newUserSnap.val();
            const registeredUser: User = {
              id: authUser.uid,
              name: u.newname || "Unbekannt",
              email: u.newemail || authUser.email || "",
              avatar: u.avatar || "/avatar1.png",
              isGuest: !!u.isGuest,
              emailVerified: authUser.isAnonymous || authUser.emailVerified,
            };

            setUser(registeredUser);
            setLoading(false);
            return;
          }

          const fallbackUser: User = {
            id: authUser.uid,
            name: authUser.isAnonymous
              ? "Gast"
              : authUser.displayName || authUser.email || "Nutzer",
            email: authUser.email || "",
            avatar: "/avatar1.png",
            isGuest: authUser.isAnonymous,
            emailVerified: authUser.isAnonymous || authUser.emailVerified,
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

  function handleRecoveryResolved() {
    setRecoveryUid(null);
    recoveryResolveRef.current?.();
    recoveryResolveRef.current = null;
  }

  return (
    <UserContext.Provider value={{ user, setUser, loading }}>
      {children}
      {recoveryUid && (
        <IdentityRecoveryModal uid={recoveryUid} onResolved={handleRecoveryResolved} />
      )}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within a UserProvider");
  return ctx;
}
