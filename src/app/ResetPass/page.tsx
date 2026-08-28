"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { auth } from "@/app/lib/firebase";
import { sendPasswordResetEmail } from "firebase/auth";
import Image from "next/image";
import { FirebaseError } from "firebase/app";
import { ArrowLeft, Mail } from "lucide-react";

export default function ResetPassword() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    auth.languageCode = "de";
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!email.trim()) return;
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setSent(true);
    } catch (e: unknown) {
      const fe = e as FirebaseError | Error;
      const code = "code" in (fe as FirebaseError) ? (fe as FirebaseError).code : null;

      if (code === "auth/user-not-found") {
        // Bewusst wie ein Erfolg behandeln statt einen eigenen Fehler zu
        // zeigen: sonst ließe sich anhand der Fehlermeldung durchprobieren,
        // welche E-Mail-Adressen überhaupt registriert sind (Account-
        // Enumeration).
        setSent(true);
      } else if (code === "auth/invalid-email") {
        setErr("Die E-Mail-Adresse ist ungültig.");
      } else {
        setErr("E-Mail konnte nicht gesendet werden.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] px-4 relative overflow-x-hidden">
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

      <div className="card-surface relative p-8 max-w-md w-full">
        <div className="absolute left-6 top-8">
          <Link
            href="/Login"
            className="btn-icon w-9 h-9"
            aria-label="Zurück zur Anmeldung"
          >
            <ArrowLeft size={18} />
          </Link>
        </div>

        <h1 className="text-2xl font-semibold text-[var(--foreground)] text-center mb-2">
          Passwort zurücksetzen
        </h1>
        <p className="text-center text-sm text-[var(--foreground-secondary)] mb-6">
          Bitte geben Sie Ihre E-Mail-Adresse ein.
        </p>

        {sent ? (
          <div className="space-y-6">
            <p
              className="text-center text-sm rounded-xl px-4 py-3"
              style={{
                color: "var(--success)",
                background: "var(--success-bg)",
              }}
            >
              Wenn ein Konto zu <span className="font-medium">{email}</span>{" "}
              existiert, wurde eine E-Mail zum Zurücksetzen gesendet.
            </p>
            <button
              onClick={() => router.push("/Login")}
              className="btn-primary w-full cursor-pointer"
            >
              Zur Anmeldung
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="input-pill">
              <Mail size={18} className="text-[var(--foreground-secondary)]" />
              <input
                type="email"
                placeholder="beispielname@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {err && (
              <p
                className="text-center text-xs"
                style={{ color: "var(--danger)" }}
              >
                {err}
              </p>
            )}

            <p className="text-center text-xs text-[var(--foreground-secondary)]">
              Wir senden Ihnen eine E-Mail, über die Sie Ihr Passwort ändern
              können.
            </p>

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="btn-primary w-full cursor-pointer mt-2"
            >
              {loading ? "Sende..." : "E-Mail senden"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
