"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound, TriangleAlert } from "lucide-react";
import { restoreIdentityBackup, republishOwnPublicKey } from "@/app/lib/crypto";

type Props = {
  uid: string;
  onResolved: () => void;
};

/**
 * Erscheint, wenn ensureIdentityKeys() feststellt, dass die lokale Identität
 * fehlt (typischerweise: Browser hat IndexedDB nach längerer Inaktivität
 * geräumt), ABER ein Schlüssel-Backup existiert — statt stillschweigend
 * eine neue, unabhängige Identität zu erzeugen (die alle bisherigen
 * Nachrichten dieses Geräts dauerhaft unlesbar macht), bekommt der Nutzer
 * hier die Wahl.
 */
export default function IdentityRecoveryModal({ uid, onResolved }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingNew, setConfirmingNew] = useState(false);

  async function handleRestore() {
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      await restoreIdentityBackup(uid, passphrase);
      await republishOwnPublicKey(uid);
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wiederherstellung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-overlay z-[100]"
      role="alertdialog"
      aria-modal="true"
      aria-label="Schlüssel wiederherstellen"
    >
      <div className="modal-card w-full max-w-[440px] p-6 sm:p-7">
        <div className="flex items-center gap-2 mb-2">
          <KeyRound size={20} className="text-[var(--accent)] shrink-0" />
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            Schlüssel auf diesem Gerät nicht gefunden
          </h2>
        </div>
        <p className="text-sm text-[var(--foreground-secondary)] mb-4">
          Vermutlich hat dein Browser lokale Daten nach längerer Inaktivität
          automatisch gelöscht. Es existiert aber ein automatisches
          Schlüssel-Backup — gib dein normales Account-Passwort ein, um deine
          Identität wiederherzustellen und weiterhin auf alte Nachrichten
          zugreifen zu können.
        </p>

        {!confirmingNew ? (
          <>
            <div className="input-pill mb-2">
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Account-Passwort"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleRestore()}
              />
            </div>
            {error && (
              <p className="text-xs text-[var(--danger)] mb-3">{error}</p>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <button
                type="button"
                onClick={() => setConfirmingNew(true)}
                className="btn-secondary text-sm"
                disabled={busy}
              >
                Ohne Backup fortfahren
              </button>
              <button
                type="button"
                onClick={handleRestore}
                disabled={!passphrase || busy}
                className="btn-primary text-sm"
              >
                {busy ? "Stellt wieder her…" : "Wiederherstellen"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2 mb-4 p-3 rounded-xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] border border-[var(--danger)]">
              <TriangleAlert size={16} className="text-[var(--danger)] shrink-0 mt-0.5" />
              <p className="text-xs text-[var(--foreground)]">
                Ohne Wiederherstellung wird eine komplett neue Identität erzeugt.
                Alle bisherigen Nachrichten auf diesem Gerät werden dann
                <strong> dauerhaft unlesbar</strong>. Das lässt sich später nicht
                mehr rückgängig machen.
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmingNew(false)}
                className="btn-secondary text-sm"
              >
                Zurück
              </button>
              <button
                type="button"
                onClick={onResolved}
                className="btn-secondary text-[var(--danger)] border-[var(--danger)] text-sm"
              >
                Neue Identität erstellen
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
