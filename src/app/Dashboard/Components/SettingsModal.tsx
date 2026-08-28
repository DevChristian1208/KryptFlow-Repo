"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ref, update, get } from "firebase/database";
import {
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword,
  multiFactor,
  TotpMultiFactorGenerator,
  type TotpSecret,
  type MultiFactorInfo,
} from "firebase/auth";
import QRCode from "qrcode";
import { db, auth } from "@/app/lib/firebase";
import {
  X,
  Upload,
  TriangleAlert,
  User as UserIcon,
  Shield,
  Settings as SettingsIcon,
  Monitor,
} from "lucide-react";
import { useToast } from "@/app/Context/ToastContext";
import { useUser } from "@/app/Context/UserContext";
import { useSession } from "@/app/Context/SessionContext";
import { uploadImage, ImageValidationError } from "@/app/lib/uploadImage";
import DeleteAccountModal from "./DeleteAccountModal";

const PRESET_AVATARS = [
  "/avatar1.png",
  "/avatar2.png",
  "/avatar3.png",
  "/avatar4.png",
  "/avatar5.png",
  "/avatar6.png",
];

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

type Tab = "profile" | "security" | "account";

function humanizeAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  const map: Record<string, string> = {
    "auth/wrong-password": "Falsches Passwort.",
    "auth/invalid-credential": "Falsches Passwort.",
    "auth/weak-password": "Neues Passwort ist zu schwach (min. 8 Zeichen).",
    "auth/requires-recent-login":
      "Aus Sicherheitsgründen bitte aus- und wieder einloggen und erneut versuchen.",
    "auth/invalid-verification-code": "Der eingegebene Code ist falsch.",
  };
  return (code && map[code]) || "Vorgang fehlgeschlagen. Bitte erneut versuchen.";
}

export default function SettingsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>("profile");
  const { user, setUser } = useUser();
  const { showToast } = useToast();

  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (isOpen && user) {
      setName(user.name || "");
      setAvatar(user.avatar || "/avatar1.png");
      setTab("profile");
    }
  }, [isOpen, user]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handleFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (
    e
  ) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;

    setUploading(true);
    try {
      const url = await uploadImage(file, `avatars/${user.id}_${Date.now()}`);
      setAvatar(url);
    } catch (err) {
      console.error("[SettingsModal] Avatar-Upload fehlgeschlagen:", err);
      showToast(
        err instanceof ImageValidationError
          ? err.message
          : "Hochladen fehlgeschlagen. Bitte erneut versuchen.",
        "error"
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  async function handleSave() {
    if (!user?.id || saving) return;
    const cleanName = name.trim();
    if (!cleanName) {
      showToast("Bitte einen Namen eingeben.", "error");
      return;
    }
    setSaving(true);
    try {
      await update(ref(db, `newusers/${user.id}`), {
        newname: cleanName,
        avatar,
      });
      setUser({ ...user, name: cleanName, avatar });
      showToast("Profil aktualisiert.", "success");
      onClose();
    } catch (err) {
      console.error("[SettingsModal] Speichern fehlgeschlagen:", err);
      showToast("Speichern fehlgeschlagen. Bitte erneut versuchen.", "error");
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen || !mounted) return null;

  const TABS: { id: Tab; label: string; icon: typeof UserIcon }[] = [
    { id: "profile", label: "Profil", icon: UserIcon },
    { id: "security", label: "Sicherheit", icon: Shield },
    { id: "account", label: "Konto", icon: SettingsIcon },
  ];

  return createPortal(
    <>
      <div
        className="modal-overlay z-[60]"
        onClick={(e) => e.currentTarget === e.target && onClose()}
        role="dialog"
        aria-modal="true"
        aria-label="Einstellungen"
      >
        <div className="modal-card w-full max-w-[640px] p-6 sm:p-8">
          <button
            onClick={onClose}
            className="btn-icon absolute top-5 right-5 w-9 h-9 text-[var(--foreground-secondary)]"
            aria-label="Modal schließen"
          >
            <X size={18} />
          </button>

          <h2 className="text-xl sm:text-2xl font-semibold mb-6 text-[var(--foreground)]">
            Einstellungen
          </h2>

          <div className="flex gap-1 mb-6 border-b border-[var(--border-subtle)]">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                  tab === t.id
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
                }`}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>

          {tab === "profile" && (
            <div>
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-3">
                  Profil
                </h3>

                <div className="flex items-center gap-4 mb-4">
                  <div className="w-20 h-20 rounded-full overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shrink-0 relative">
                    <Image
                      src={avatar || "/avatar1.png"}
                      alt="Profilbild"
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="btn-secondary text-sm"
                    >
                      <Upload size={14} />
                      {uploading ? "Wird hochgeladen…" : "Eigenes Bild hochladen"}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleFileSelected}
                    />
                  </div>
                </div>

                <div className="flex gap-2 mb-4">
                  {PRESET_AVATARS.map((src) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => !uploading && setAvatar(src)}
                      disabled={uploading}
                      className={`w-10 h-10 rounded-full border-2 transition disabled:opacity-40 ${
                        avatar === src ? "border-[var(--accent)]" : "border-transparent"
                      }`}
                    >
                      <Image src={src} alt="" width={40} height={40} className="rounded-full" />
                    </button>
                  ))}
                </div>

                <label className="block font-medium text-sm mb-1 text-[var(--foreground)]">
                  Name
                </label>
                <div className="input-pill">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    type="text"
                    placeholder="Dein Name"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <button onClick={onClose} className="btn-secondary">
                  Abbrechen
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !name.trim()}
                  className="btn-primary"
                >
                  {saving ? "Speichert…" : "Speichern"}
                </button>
              </div>
            </div>
          )}

          {tab === "security" && <SecurityTab />}

          {tab === "account" && (
            <div>
              <UsernameSection />
              <SessionsSection />

              <div className="pt-6 border-t border-[var(--border-subtle)]">
                <h3 className="text-sm font-semibold text-[var(--danger)] uppercase tracking-wide mb-3 flex items-center gap-2">
                  <TriangleAlert size={14} /> Danger Zone
                </h3>
                <p className="text-sm text-[var(--foreground-secondary)] mb-3">
                  Dein Konto und alle zugehörigen Daten dauerhaft löschen.
                </p>
                <button
                  onClick={() => setDeleteOpen(true)}
                  className="btn-secondary text-[var(--danger)] border-[var(--danger)]"
                >
                  Konto löschen
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <DeleteAccountModal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </>,
    document.body
  );
}

/* -----------------------------------------------------------
 * SICHERHEIT: Passwort ändern + 2FA (TOTP, nativ über Firebase Auth MFA)
 * ---------------------------------------------------------*/
function SecurityTab() {
  const { user } = useUser();
  const { showToast } = useToast();
  const isPasswordUser = !user?.isGuest;

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [enrolledFactors, setEnrolledFactors] = useState<MultiFactorInfo[]>([]);
  const [mfaStep, setMfaStep] = useState<"idle" | "password" | "code">("idle");
  const [mfaPassword, setMfaPassword] = useState("");
  const [mfaSecret, setMfaSecret] = useState<TotpSecret | null>(null);
  const [mfaQrDataUrl, setMfaQrDataUrl] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  useEffect(() => {
    const current = auth.currentUser;
    if (current) setEnrolledFactors(multiFactor(current).enrolledFactors);
  }, []);

  async function handleChangePassword() {
    const current = auth.currentUser;
    if (!current?.email || changingPassword) return;
    if (newPassword.length < 8) {
      showToast("Neues Passwort: mind. 8 Zeichen.", "error");
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast("Die Passwörter stimmen nicht überein.", "error");
      return;
    }
    setChangingPassword(true);
    try {
      await reauthenticateWithCredential(
        current,
        EmailAuthProvider.credential(current.email, currentPassword)
      );
      await updatePassword(current, newPassword);
      showToast("Passwort geändert.", "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      showToast(humanizeAuthError(err), "error");
    } finally {
      setChangingPassword(false);
    }
  }

  async function startMfaEnrollment() {
    const current = auth.currentUser;
    if (!current?.email || mfaBusy) return;
    if (!mfaPassword.trim()) {
      showToast("Bitte dein Passwort eingeben.", "error");
      return;
    }
    setMfaBusy(true);
    try {
      await reauthenticateWithCredential(
        current,
        EmailAuthProvider.credential(current.email, mfaPassword)
      );
      const session = await multiFactor(current).getSession();
      const secret = await TotpMultiFactorGenerator.generateSecret(session);
      const qrUrl = secret.generateQrCodeUrl(current.email, "Cryptflow");
      const dataUrl = await QRCode.toDataURL(qrUrl);
      setMfaSecret(secret);
      setMfaQrDataUrl(dataUrl);
      setMfaStep("code");
    } catch (err) {
      showToast(humanizeAuthError(err), "error");
    } finally {
      setMfaBusy(false);
      setMfaPassword("");
    }
  }

  async function confirmMfaEnrollment() {
    const current = auth.currentUser;
    if (!current || !mfaSecret || mfaBusy) return;
    if (!/^\d{6}$/.test(mfaCode.trim())) {
      showToast("Bitte den 6-stelligen Code eingeben.", "error");
      return;
    }
    setMfaBusy(true);
    try {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(
        mfaSecret,
        mfaCode.trim()
      );
      await multiFactor(current).enroll(assertion, "Authenticator App");
      setEnrolledFactors(multiFactor(current).enrolledFactors);
      setMfaStep("idle");
      setMfaSecret(null);
      setMfaQrDataUrl("");
      setMfaCode("");
      showToast("Zwei-Faktor-Authentifizierung aktiviert.", "success");
    } catch (err) {
      showToast(humanizeAuthError(err), "error");
    } finally {
      setMfaBusy(false);
    }
  }

  async function disableMfa() {
    const current = auth.currentUser;
    if (!current || enrolledFactors.length === 0 || mfaBusy) return;
    setMfaBusy(true);
    try {
      await multiFactor(current).unenroll(enrolledFactors[0]);
      setEnrolledFactors([]);
      showToast("Zwei-Faktor-Authentifizierung deaktiviert.", "success");
    } catch (err) {
      showToast(humanizeAuthError(err), "error");
    } finally {
      setMfaBusy(false);
    }
  }

  if (!isPasswordUser) {
    return (
      <p className="text-sm text-[var(--foreground-secondary)] py-6 text-center">
        Sicherheitseinstellungen sind nur für registrierte Konten verfügbar.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-3">
          Passwort ändern
        </h3>
        <div className="space-y-2">
          <div className="input-pill">
            <input
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              type="password"
              placeholder="Aktuelles Passwort"
              autoComplete="current-password"
            />
          </div>
          <div className="input-pill">
            <input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              type="password"
              placeholder="Neues Passwort (mind. 8 Zeichen)"
              autoComplete="new-password"
            />
          </div>
          <div className="input-pill">
            <input
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              type="password"
              placeholder="Neues Passwort bestätigen"
              autoComplete="new-password"
            />
          </div>
        </div>
        <button
          onClick={handleChangePassword}
          disabled={changingPassword || !currentPassword || !newPassword}
          className="btn-primary mt-3"
        >
          {changingPassword ? "Ändert…" : "Passwort ändern"}
        </button>
      </div>

      <div className="pt-6 border-t border-[var(--border-subtle)]">
        <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-3">
          Zwei-Faktor-Authentifizierung
        </h3>

        {enrolledFactors.length > 0 && mfaStep === "idle" && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--success)]">✓ Aktiv (Authenticator App)</p>
            <button
              onClick={disableMfa}
              disabled={mfaBusy}
              className="btn-secondary text-[var(--danger)] border-[var(--danger)] text-sm"
            >
              Deaktivieren
            </button>
          </div>
        )}

        {enrolledFactors.length === 0 && mfaStep === "idle" && (
          <div>
            <p className="text-sm text-[var(--foreground-secondary)] mb-3">
              Schützt dein Konto zusätzlich mit einer Authenticator-App (z. B. Google
              Authenticator). Muss vorher in der Firebase Console für dieses Projekt
              aktiviert worden sein.
            </p>
            <button onClick={() => setMfaStep("password")} className="btn-secondary text-sm">
              2FA aktivieren
            </button>
          </div>
        )}

        {mfaStep === "password" && (
          <div>
            <p className="text-sm text-[var(--foreground-secondary)] mb-2">
              Zur Bestätigung dein Passwort eingeben:
            </p>
            <div className="input-pill mb-2">
              <input
                value={mfaPassword}
                onChange={(e) => setMfaPassword(e.target.value)}
                type="password"
                placeholder="Passwort"
                autoComplete="current-password"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setMfaStep("idle")}
                className="btn-secondary text-sm"
              >
                Abbrechen
              </button>
              <button
                onClick={startMfaEnrollment}
                disabled={mfaBusy || !mfaPassword}
                className="btn-primary text-sm"
              >
                {mfaBusy ? "Wird vorbereitet…" : "Weiter"}
              </button>
            </div>
          </div>
        )}

        {mfaStep === "code" && mfaSecret && (
          <div>
            <p className="text-sm text-[var(--foreground-secondary)] mb-3">
              QR-Code mit deiner Authenticator-App scannen und den generierten
              6-stelligen Code eingeben:
            </p>
            {mfaQrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mfaQrDataUrl}
                alt="TOTP QR-Code"
                width={160}
                height={160}
                className="mb-2 rounded-lg border border-[var(--border-subtle)]"
              />
            )}
            <p className="text-xs text-[var(--foreground-secondary)] mb-3 break-all">
              Manuell: {mfaSecret.secretKey}
            </p>
            <div className="input-pill mb-2 max-w-[180px]">
              <input
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                type="text"
                inputMode="numeric"
                placeholder="6-stelliger Code"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setMfaStep("idle");
                  setMfaSecret(null);
                  setMfaQrDataUrl("");
                  setMfaCode("");
                }}
                className="btn-secondary text-sm"
              >
                Abbrechen
              </button>
              <button
                onClick={confirmMfaEnrollment}
                disabled={mfaBusy || mfaCode.length !== 6}
                className="btn-primary text-sm"
              >
                {mfaBusy ? "Bestätigt…" : "Bestätigen"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------
 * KONTO: Benutzername ändern
 * ---------------------------------------------------------*/
function UsernameSection() {
  const { user } = useUser();
  const { showToast } = useToast();
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    get(ref(db, `newusers/${user.id}/username`)).then((snap) => {
      setCurrentUsername((snap.val() as string | null) || null);
    });
  }, [user?.id]);

  if (user?.isGuest) return null;

  async function handleChangeUsername() {
    if (!user?.id || saving) return;
    const clean = newUsername.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(clean)) {
      showToast(
        "Benutzername: 3–20 Zeichen, nur Kleinbuchstaben, Ziffern und Unterstrich.",
        "error"
      );
      return;
    }
    if (clean === currentUsername) {
      showToast("Das ist bereits dein aktueller Benutzername.", "error");
      return;
    }
    setSaving(true);
    try {
      // Vorab-Prüfung nur für eine schnelle Fehlermeldung im Normalfall — die
      // eigentliche Eindeutigkeit erzwingt die Firebase-Regel für
      // usernames/{name} beim Schreiben selbst (erlaubt nur, wenn frei oder
      // bereits eigen). Reservierung des neuen Namens, Freigabe des alten und
      // Aktualisierung des Profils erfolgen deshalb in EINEM einzigen
      // Mehrfach-Schreibvorgang: entweder gelingt alles zusammen, oder gar
      // nichts wird geschrieben. Anders als vorher (separate Transaction +
      // update()) kann der neue Name jetzt nicht mehr "reserviert, aber
      // nirgends im Profil eingetragen" hängen bleiben, wenn der zweite
      // Schritt fehlschlägt.
      const preCheck = await get(ref(db, `usernames/${clean}`));
      const preCheckUid = (preCheck.val() as { uid?: string } | null)?.uid;
      if (preCheck.exists() && preCheckUid !== user.id) {
        showToast("Dieser Benutzername ist bereits vergeben.", "error");
        return;
      }

      const updates: Record<string, unknown> = {
        [`usernames/${clean}`]: { uid: user.id, email: user.email || "" },
        [`newusers/${user.id}/username`]: clean,
      };
      if (currentUsername && currentUsername !== clean) {
        updates[`usernames/${currentUsername}`] = null;
      }
      await update(ref(db), updates);

      if (typeof window !== "undefined") {
        localStorage.setItem("username", clean);
      }
      setCurrentUsername(clean);
      setNewUsername("");
      showToast("Benutzername geändert.", "success");
    } catch (err) {
      console.error("[SettingsModal] Benutzername ändern fehlgeschlagen:", err);
      const denied =
        err instanceof Error && /permission[_ ]denied/i.test(err.message);
      showToast(
        denied
          ? "Dieser Benutzername ist bereits vergeben."
          : "Ändern fehlgeschlagen. Bitte erneut versuchen.",
        "error"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-8">
      <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-3">
        Benutzername
      </h3>
      {currentUsername && (
        <p className="text-sm text-[var(--foreground)] mb-2">
          Aktuell: <span className="font-medium">@{currentUsername}</span>
        </p>
      )}
      <div className="flex gap-2">
        <div className="input-pill flex-1">
          <span className="text-[var(--foreground-secondary)]">@</span>
          <input
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
            type="text"
            placeholder="neuer-benutzername"
            minLength={3}
            maxLength={20}
          />
        </div>
        <button
          onClick={handleChangeUsername}
          disabled={saving || !newUsername.trim()}
          className="btn-secondary shrink-0"
        >
          {saving ? "Ändert…" : "Ändern"}
        </button>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------
 * KONTO: Sitzungen/Geräte
 * ---------------------------------------------------------*/
function SessionsSection() {
  const { sessions, currentSessionId, endSession } = useSession();

  function describe(userAgent?: string): string {
    if (!userAgent) return "Unbekanntes Gerät";
    if (/iPhone|iPad/.test(userAgent)) return "iOS · Safari";
    if (/Android/.test(userAgent)) return "Android";
    if (/Macintosh/.test(userAgent)) return "Mac";
    if (/Windows/.test(userAgent)) return "Windows";
    if (/Linux/.test(userAgent)) return "Linux";
    return "Unbekanntes Gerät";
  }

  return (
    <div className="mb-8 pt-6 border-t border-[var(--border-subtle)]">
      <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-3">
        Sitzungen / Geräte
      </h3>
      <div className="space-y-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--surface-elevated)] border border-[var(--border-subtle)]"
          >
            <Monitor size={16} className="text-[var(--foreground-secondary)] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-[var(--foreground)] truncate">
                {describe(s.userAgent)}
                {s.id === currentSessionId && (
                  <span className="ml-2 text-xs text-[var(--accent)]">Dieses Gerät</span>
                )}
              </div>
              <div className="text-xs text-[var(--foreground-secondary)]">
                Zuletzt aktiv:{" "}
                {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString("de-DE") : "—"}
              </div>
            </div>
            {s.id !== currentSessionId && (
              <button
                onClick={() => endSession(s.id)}
                className="btn-secondary text-xs shrink-0"
              >
                Abmelden
              </button>
            )}
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="text-sm text-[var(--foreground-secondary)]">
            Keine aktiven Sitzungen gefunden.
          </p>
        )}
      </div>
    </div>
  );
}
