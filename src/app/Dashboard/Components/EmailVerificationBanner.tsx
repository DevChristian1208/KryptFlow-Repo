"use client";

import { useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import { auth } from "@/app/lib/firebase";
import { useUser } from "@/app/Context/UserContext";
import { useToast } from "@/app/Context/ToastContext";
import { Mail, X } from "lucide-react";

export default function EmailVerificationBanner() {
  const { user } = useUser();
  const { showToast } = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  if (!user || user.isGuest || user.emailVerified !== false || dismissed) {
    return null;
  }

  async function handleResend() {
    if (!auth.currentUser || sending) return;
    setSending(true);
    try {
      await sendEmailVerification(auth.currentUser);
      setSent(true);
      showToast("Bestätigungs-E-Mail gesendet.", "success");
    } catch {
      showToast(
        "Senden fehlgeschlagen. Bitte kurz warten und erneut versuchen.",
        "error"
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="w-full px-3 md:px-10 pt-2">
      <div className="flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-4 py-2.5 text-sm">
        <Mail size={16} className="text-[var(--accent)] shrink-0" />
        <span className="flex-1 text-[var(--foreground)]">
          Bitte bestätige deine E-Mail-Adresse, um dein Konto vollständig abzusichern.
        </span>
        <button
          type="button"
          onClick={handleResend}
          disabled={sending}
          className="text-[var(--accent)] font-medium hover:underline shrink-0"
        >
          {sending ? "Sendet…" : sent ? "Erneut senden" : "Bestätigungs-E-Mail senden"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hinweis ausblenden"
          className="btn-icon w-7 h-7 shrink-0 text-[var(--foreground-secondary)]"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
