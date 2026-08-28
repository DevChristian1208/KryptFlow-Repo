//Login Page

"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useUser } from "@/app/Context/UserContext";
import { useToast } from "@/app/Context/ToastContext";
import { useServer } from "@/app/Context/ServerContext";
import {
  signInWithEmailAndPassword,
  signInAnonymously,
  getMultiFactorResolver,
  TotpMultiFactorGenerator,
  type MultiFactorResolver,
  type MultiFactorError,
  type UserCredential,
} from "firebase/auth";
import { auth, db } from "@/app/lib/firebase";
import { ref, get, query, orderByChild, equalTo } from "firebase/database";
import { FirebaseError } from "firebase/app";
import { Eye, EyeOff, Mail, Lock } from "lucide-react";

type RawUser = {
  newname?: string;
  newemail?: string;
  avatar?: string;
  authUid?: string;
};

function humanizeAuthError(err: unknown): string {
  if (err instanceof FirebaseError) {
    const map: Record<string, string> = {
      "auth/invalid-credential": "E-Mail oder Passwort ist falsch.",
      "auth/invalid-email": "Die E-Mail-Adresse ist ungültig.",
      "auth/user-disabled": "Dieses Konto ist deaktiviert.",
      "auth/user-not-found": "Es gibt kein Konto mit dieser E-Mail.",
      "auth/wrong-password": "E-Mail oder Passwort ist falsch.",
      "auth/too-many-requests":
        "Zu viele Versuche. Bitte kurz warten oder Passwort zurücksetzen.",
      "auth/network-request-failed":
        "Netzwerkfehler. Prüfe deine Internetverbindung.",
      "auth/configuration-not-found":
        "Firebase-Auth nicht richtig konfiguriert.",
      "auth/invalid-verification-code": "Der eingegebene Code ist falsch.",
    };
    return map[err.code] || `Anmeldung fehlgeschlagen: ${err.message}`;
  }
  return "Anmeldung fehlgeschlagen.";
}

export default function Login() {
  const router = useRouter();
  const { setUser } = useUser();
  const { showToast } = useToast();
  const { joinServerByInviteCode } = useServer();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPasswort, setShowPasswort] = useState(false);
  const [loading, setLoading] = useState(false);

  const [mfaResolver, setMfaResolver] = useState<MultiFactorResolver | null>(
    null,
  );
  const [mfaCode, setMfaCode] = useState("");

  async function completeLogin(cred: UserCredential) {
    const uid = cred.user.uid;
    const usersRef = ref(db, "newusers");
    const byUid = query(usersRef, orderByChild("authUid"), equalTo(uid));
    const snapByUid = await get(byUid);

    let data: RawUser | null = null;
    if (snapByUid.exists()) {
      const obj = snapByUid.val() as Record<string, RawUser>;
      data = Object.values(obj)[0];
    } else if (cred.user.email) {
      const byEmail = query(
        usersRef,
        orderByChild("newemail"),
        equalTo(cred.user.email),
      );
      const snapByEmail = await get(byEmail);
      if (snapByEmail.exists()) {
        const obj = snapByEmail.val() as Record<string, RawUser>;
        data = Object.values(obj)[0];
      }
    }

    const finalName =
      data?.newname ||
      cred.user.displayName ||
      cred.user.email?.split("@")[0] ||
      "Nutzer";
    const finalEmail = data?.newemail || cred.user.email || "";
    const finalAvatar = data?.avatar || "/avatar1.png";

    setUser({
      id: uid,
      name: finalName,
      email: finalEmail,
      avatar: finalAvatar,
      isGuest: false,
    });

    if (data) {
      // Ausstehenden Server-Einladungslink (Klick auf /invite/... während
      // ausgeloggt, siehe invite/[code]/page.tsx) jetzt nachträglich einlösen.
      let pendingInvite: string | null = null;
      try {
        pendingInvite = localStorage.getItem("cryptflow_pending_invite_code");
        if (pendingInvite)
          localStorage.removeItem("cryptflow_pending_invite_code");
      } catch {}
      if (pendingInvite) {
        // uid explizit durchreichen statt sich auf den user-State zu
        // verlassen: setUser(...) oben aktualisiert diesen erst beim
        // nächsten Rendern, im Closure hier wäre er noch null. Ein
        // Fehlschlag beim Einlösen (abgelaufener/ungültiger Link) darf
        // außerdem nicht den ansonsten erfolgreichen Login abbrechen.
        try {
          await joinServerByInviteCode(pendingInvite, uid);
        } catch (e) {
          console.error("[Login] Einladung konnte nicht eingelöst werden:", e);
        }
      }
      router.push("/Dashboard");
    } else {
      // Kein newusers/$uid-Eintrag vorhanden: die Registrierung wurde nie
      // abgeschlossen (Tab vor SelectAvatar geschlossen o. Ä.). Statt
      // stillschweigend ein Profil mit Zufalls-Avatar anzulegen, zur
      // Vervollständigung schicken statt direkt ins Dashboard.
      router.push("/SelectAvatar");
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier || !password) return;
    setLoading(true);

    try {
      // Login ist sowohl per E-Mail als auch per Benutzername möglich —
      // enthält die Eingabe kein "@", wird sie als Benutzername behandelt
      // und zuerst auf die zugehörige E-Mail aufgelöst (usernames/$username
      // ist bewusst ohne Login schon lesbar, siehe database.rules.json,
      // sonst könnte man vor dem eigentlichen Login gar nicht herausfinden,
      // welche E-Mail zum Benutzernamen gehört).
      let resolvedEmail = identifier.trim();
      if (!resolvedEmail.includes("@")) {
        const unameSnap = await get(
          ref(db, `usernames/${resolvedEmail.toLowerCase()}`),
        );
        if (!unameSnap.exists()) {
          showToast("Es gibt kein Konto mit diesem Benutzernamen.", "error");
          setLoading(false);
          return;
        }
        resolvedEmail = (unameSnap.val() as { email?: string }).email || "";
        if (!resolvedEmail) {
          showToast("Anmeldung fehlgeschlagen.", "error");
          setLoading(false);
          return;
        }
      }

      const cred = await signInWithEmailAndPassword(
        auth,
        resolvedEmail,
        password,
      );
      await completeLogin(cred);
    } catch (err) {
      if (
        err instanceof FirebaseError &&
        err.code === "auth/multi-factor-auth-required"
      ) {
        setMfaResolver(getMultiFactorResolver(auth, err as MultiFactorError));
        setLoading(false);
        return;
      }
      showToast(humanizeAuthError(err), "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaResolver || mfaCode.trim().length !== 6) return;
    setLoading(true);
    try {
      const hint = mfaResolver.hints[0];
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(
        hint.uid,
        mfaCode.trim(),
      );
      const cred = await mfaResolver.resolveSignIn(assertion);
      await completeLogin(cred);
    } catch (err) {
      showToast(humanizeAuthError(err), "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleGuestLogin() {
    setLoading(true);
    try {
      const cred = await signInAnonymously(auth);

      setUser({
        id: cred.user.uid,
        name: "Gast",
        email: "",
        avatar: "/avatar1.png",
        isGuest: true,
      });

      router.push("/SelectAvatar");
    } catch (err) {
      showToast(humanizeAuthError(err), "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--background)] px-4 pt-6 relative overflow-x-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -top-40 -left-32 h-96 w-96 rounded-full bg-[var(--accent)]/20 blur-3xl" />
        <div className="absolute -bottom-40 -right-32 h-96 w-96 rounded-full bg-[var(--accent)]/10 blur-3xl" />
      </div>

      <div className="absolute top-6 left-6 flex items-center gap-2">
        <Image src="/Logo.svg" alt="Logo" width={30} height={30} />
        <span className="text-lg font-semibold text-[var(--foreground)]">
          Cryptflow
        </span>
      </div>

      <div className="absolute top-6 right-6 text-sm text-[var(--foreground-secondary)] flex flex-col items-end">
        <span>Neu bei Cryptflow?</span>
        <Link
          href="/Newuser"
          className="text-[var(--accent)] font-medium hover:underline"
        >
          Konto erstellen
        </Link>
      </div>

      <div className="flex justify-center items-center min-h-screen">
        <div className="card-surface relative w-full max-w-sm p-8 space-y-6 mt-12">
          {mfaResolver ? (
            <>
              <h1 className="text-3xl font-semibold text-center text-[var(--foreground)]">
                Bestätigungscode
              </h1>
              <p className="text-center text-[var(--foreground-secondary)] text-sm">
                Gib den 6-stelligen Code aus deiner Authenticator-App ein.
              </p>
              <form className="space-y-4" onSubmit={handleMfaSubmit}>
                <div className="input-pill">
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    autoFocus
                    placeholder="6-stelliger Code"
                    value={mfaCode}
                    onChange={(e) =>
                      setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                  />
                </div>
                <div className="flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMfaResolver(null);
                      setMfaCode("");
                    }}
                    className="btn-secondary cursor-pointer"
                  >
                    Zurück
                  </button>
                  <button
                    type="submit"
                    className="btn-primary cursor-pointer"
                    disabled={loading || mfaCode.length !== 6}
                  >
                    {loading ? "Prüft…" : "Bestätigen"}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-semibold text-center text-[var(--foreground)]">
                Anmeldung
              </h1>
              <p className="text-center text-[var(--foreground-secondary)] text-sm">
                Melde dich mit deiner E-Mail-Adresse oder deinem Benutzernamen
                an.
              </p>

              <form className="space-y-4" onSubmit={handleLogin}>
                <div className="input-pill">
                  <Mail
                    size={17}
                    className="text-[var(--foreground-secondary)]"
                  />
                  <input
                    type="text"
                    required
                    placeholder="E-Mail oder Benutzername"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    autoComplete="username"
                  />
                </div>

                <div className="input-pill relative">
                  <Lock
                    size={18}
                    className="text-[var(--foreground-secondary)]"
                  />
                  <input
                    type={showPasswort ? "text" : "password"}
                    required
                    placeholder="Passwort"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="pr-8"
                  />

                  <button
                    type="button"
                    onClick={() => setShowPasswort(!showPasswort)}
                    onMouseDown={(e) => e.preventDefault()}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
                  >
                    {showPasswort ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>

                <div className="text-right">
                  <Link
                    href="/ResetPass"
                    className="flex justify-center text-sm text-[var(--accent)] hover:underline"
                  >
                    Passwort vergessen?
                  </Link>
                </div>

                <div className="flex items-center justify-center gap-2">
                  <div className="h-px bg-[var(--border-subtle)] w-full" />
                  <span className="text-sm text-[var(--foreground-secondary)]">
                    ODER
                  </span>
                  <div className="h-px bg-[var(--border-subtle)] w-full" />
                </div>

                <button
                  type="button"
                  className="btn-secondary w-full"
                  onClick={() =>
                    showToast(
                      "Google-Login ist noch nicht implementiert.",
                      "info",
                    )
                  }
                >
                  <Image
                    src="/Google.png"
                    alt="Google"
                    width={20}
                    height={20}
                  />
                  <span>Anmelden mit Google</span>
                </button>

                <div className="flex justify-center gap-2">
                  <button
                    type="submit"
                    className="btn-primary cursor-pointer"
                    disabled={loading}
                  >
                    {loading ? "Anmelden..." : "Anmelden"}
                  </button>
                  <button
                    type="button"
                    onClick={handleGuestLogin}
                    disabled={loading}
                    className="btn-secondary cursor-pointer"
                  >
                    Gäste-Login
                  </button>
                </div>
              </form>
            </>
          )}
          <div className="mt-8 flex justify-center gap-6 text-sm text-[var(--foreground-secondary)]">
            <Link
              href="/ImpressumundDatenschutz/LegalNotice"
              className="hover:underline"
            >
              Impressum
            </Link>
            <Link
              href="/ImpressumundDatenschutz/PrivacyPolicy"
              className="hover:underline"
            >
              Datenschutz
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
