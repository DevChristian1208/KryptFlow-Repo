"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { auth, db } from "@/app/lib/firebase";
// Die beiden Funktionen arbeiten nur in der FB Auth und nicht in der RD
//createUserWithEmailAndPassword -> erstellt neuen User in der Auth mit auth (UID), email und pw
//updateProfile setzt displayname in Auth
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { ref, runTransaction } from "firebase/database";
import { FirebaseError } from "firebase/app";
import { Eye, EyeOff, User, AtSign, Mail, Lock } from "lucide-react";
import { useToast } from "@/app/Context/ToastContext";

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export default function Register() {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setMail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accept, setAccept] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { showToast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!accept || loading) return;

    const cleanUsername = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(cleanUsername)) {
      showToast(
        "Benutzername: 3–20 Zeichen, nur Kleinbuchstaben, Ziffern und Unterstrich.",
        "error"
      );
      return;
    }

    setLoading(true);

    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (name.trim() !== "") {
        await updateProfile(cred.user, { displayName: name.trim() });
      }
      // Bewusst KEIN automatischer Versand hier: die eingegebene Adresse ist
      // zu diesem Zeitpunkt noch unbestätigt und könnte jemand anderem
      // gehören — ungefragt eine E-Mail an eine fremde Adresse zu schicken
      // wäre selbst ein Missbrauchsvektor. Der Versand passiert erst, wenn
      // der Nutzer im Hinweis-Banner (EmailVerificationBanner.tsx) im
      // Dashboard aktiv draufklickt.

      // Benutzername atomar beanspruchen (Firebase kennt keine Unique-
      // Constraints — die Transaction stellt sicher, dass zwei Leute nicht
      // gleichzeitig denselben Namen bekommen). Schlägt sie fehl, bleibt der
      // Nutzer eingeloggt auf dieser Seite und kann sofort einen anderen
      // Namen versuchen; das Auth-Konto existiert dann zwar schon ohne
      // newusers-Profil, aber genau dieses Zwischen-Szenario fängt Login.tsx
      // bereits ab (leitet zu /SelectAvatar weiter).
      const usernameRef = ref(db, `usernames/${cleanUsername}`);
      const result = await runTransaction(usernameRef, (current) =>
        current === null ? { uid: cred.user.uid, email } : undefined
      );
      if (!result.committed) {
        showToast(
          "Dieser Benutzername ist bereits vergeben. Bitte wähle einen anderen.",
          "error"
        );
        return;
      }

      localStorage.setItem("userEmail", email);
      localStorage.setItem("userName", name);
      localStorage.setItem("username", cleanUsername);

      router.push("/SelectAvatar");
    } catch (err: unknown) {
      const code = err instanceof FirebaseError ? err.code : "unknown";

      const friendly =
        code === "auth/operation-not-allowed"
          ? "E-Mail/Passwort-Login ist im Firebase-Backend deaktiviert."
          : code === "auth/email-already-in-use"
          ? "Diese E-Mail ist bereits registriert."
          : code === "auth/weak-password"
          ? "Passwort zu schwach."
          : code === "auth/invalid-email"
          ? "E-Mail ungültig."
          : "Unbekannter Fehler. Details in der Konsole.";

      console.error("Registrierung fehlgeschlagen:", err);
      showToast(friendly, "error");
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

      <div className="flex justify-center items-center min-h-screen">
        <form
          onSubmit={handleSubmit}
          className="card-surface relative w-full max-w-sm p-8 space-y-6 mt-12"
        >
          <h1 className="text-2xl font-semibold text-center text-[var(--foreground)]">
            Konto erstellen
          </h1>
          <p className="text-center text-[var(--foreground-secondary)] text-sm">
            Mit deinem Namen und deiner E-Mail erhältst du dein neues
            Cryptflow-Konto.
          </p>

          <div className="input-pill">
            <User size={20} className="text-[var(--foreground-secondary)]" />
            <input
              type="text"
              required
              placeholder="Name und Nachname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </div>

          <div className="input-pill">
            <AtSign size={20} className="text-[var(--foreground-secondary)]" />
            <input
              type="text"
              required
              placeholder="benutzername"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              autoComplete="off"
              minLength={3}
              maxLength={20}
            />
          </div>

          <div className="input-pill">
            <Mail size={20} className="text-[var(--foreground-secondary)]" />
            <input
              type="email"
              required
              placeholder="beispiel@email.com"
              value={email}
              onChange={(e) => setMail(e.target.value)}
              autoComplete="email"
            />
          </div>

          <div className="input-pill relative">
            <Lock size={20} className="text-[var(--foreground-secondary)]" />
            <input
              type={showPassword ? "text" : "password"}
              required
              placeholder="Passwort"
              className="pr-8"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
            />
            <button
              type="button"
              onClick={() => setShowPassword((show) => !show)}
              onMouseDown={(e) => e.preventDefault()}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
              aria-label={
                showPassword ? "Passwort verbergen" : "Passwort anzeigen"
              }
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          <div className="flex items-center gap-2 text-sm text-[var(--foreground-secondary)]">
            <input
              type="checkbox"
              id="accept"
              required
              checked={accept}
              onChange={(e) => setAccept(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <label htmlFor="accept">
              Ich stimme der{" "}
              <Link
                href="/ImpressumundDatenschutz/PrivacyPolicy"
                className="text-[var(--accent)] hover:underline"
              >
                Datenschutzerklärung
              </Link>{" "}
              zu.
            </label>
          </div>

          <button
            type="submit"
            disabled={loading || !accept}
            className="btn-primary w-full"
          >
            {loading ? "Wird gesendet..." : "Weiter"}
          </button>

          <p className="text-center text-sm text-[var(--foreground-secondary)]">
            Schon ein Konto?{" "}
            <Link
              href="/Login"
              className="text-[var(--accent)] hover:underline font-medium"
            >
              Hier einloggen
            </Link>
          </p>
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
        </form>
      </div>
    </div>
  );
}
