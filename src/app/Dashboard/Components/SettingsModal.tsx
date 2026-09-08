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
  Plus,
  Instagram,
  Github,
  Linkedin,
  Youtube,
  Twitter,
  Twitch,
  Globe,
  Music2,
  MessageCircle,
  Link as LinkIconOther,
} from "lucide-react";

export const SOCIAL_PLATFORMS = [
  { id: "instagram", label: "Instagram", icon: Instagram },
  { id: "twitter", label: "X (Twitter)", icon: Twitter },
  { id: "tiktok", label: "TikTok", icon: Music2 },
  { id: "youtube", label: "YouTube", icon: Youtube },
  { id: "github", label: "GitHub", icon: Github },
  { id: "linkedin", label: "LinkedIn", icon: Linkedin },
  { id: "discord", label: "Discord", icon: MessageCircle },
  { id: "twitch", label: "Twitch", icon: Twitch },
  { id: "website", label: "Website", icon: Globe },
  { id: "other", label: "Sonstiges", icon: LinkIconOther },
] as const;
import { useToast } from "@/app/Context/ToastContext";
import { useUser } from "@/app/Context/UserContext";
import { useSession } from "@/app/Context/SessionContext";
import { uploadImage, ImageValidationError } from "@/app/lib/uploadImage";
import { exportIdentityBackup } from "@/app/lib/crypto";
import { APP_VERSION } from "@/app/lib/version";
import {
  logSecurityEvent,
  getRecentSecurityEvents,
  labelForSecurityEvent,
  type SecurityEvent,
} from "@/app/lib/securityLog";
import DeleteAccountModal from "./DeleteAccountModal";
import AvatarLightbox from "./AvatarLightbox";
import AvatarCropModal from "./AvatarCropModal";

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
    "auth/too-many-requests":
      "Zu viele Versuche. Bitte kurz warten und erneut versuchen.",
    "auth/network-request-failed":
      "Netzwerkfehler. Prüfe deine Internetverbindung.",
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
  const [socialLinks, setSocialLinks] = useState<
    { id: string; platform: string; label: string; url: string }[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [avatarLightboxOpen, setAvatarLightboxOpen] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
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
    if (!isOpen || !user?.id) return;
    get(ref(db, `newusers/${user.id}/socialLinks`)).then((snap) => {
      const raw =
        (snap.val() as Record<
          string,
          { platform?: string; label: string; url: string }
        > | null) || {};
      setSocialLinks(
        Object.entries(raw).map(([id, v]) => ({
          id,
          platform: v.platform || "other",
          label: v.label,
          url: v.url,
        }))
      );
    });
  }, [isOpen, user?.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handleFileSelected: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCropFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  async function handleCropped(blob: Blob) {
    setCropFile(null);
    if (!user?.id) return;
    setUploading(true);
    try {
      const croppedFile = new File([blob], "avatar.jpg", { type: "image/jpeg" });
      const url = await uploadImage(croppedFile, `avatars/${user.id}_${Date.now()}`);
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
    }
  }

  async function handleSave() {
    if (!user?.id || saving) return;
    const cleanName = name.trim();
    if (!cleanName) {
      showToast("Bitte einen Namen eingeben.", "error");
      return;
    }
    setSaving(true);
    try {
      const cleanLinks = socialLinks.filter((l) => l.label.trim() && l.url.trim());
      const socialLinksValue = cleanLinks.length
        ? Object.fromEntries(
            cleanLinks.map((l) => [
              l.id,
              { platform: l.platform, label: l.label.trim(), url: l.url.trim() },
            ])
          )
        : null;
      await update(ref(db, `newusers/${user.id}`), {
        newname: cleanName,
        avatar,
        socialLinks: socialLinksValue,
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
        <div className="modal-card w-full max-w-[640px] max-h-[85vh] overflow-y-auto p-6 sm:p-8">
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
                  <button
                    type="button"
                    onClick={() => setAvatarLightboxOpen(true)}
                    title="Profilbild vergrößern"
                    className="w-20 h-20 rounded-full overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shrink-0 relative hover:opacity-80 transition"
                  >
                    <Image
                      src={avatar || "/avatar1.png"}
                      alt="Profilbild"
                      fill
                      className="object-cover"
                    />
                  </button>
                  <AvatarLightbox
                    open={avatarLightboxOpen}
                    onClose={() => setAvatarLightboxOpen(false)}
                    src={avatar || "/avatar1.png"}
                    alt="Profilbild"
                    size={260}
                  />
                  <AvatarCropModal
                    file={cropFile}
                    onCancel={() => setCropFile(null)}
                    onCropped={handleCropped}
                  />
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
                      <Image src={src} alt="" width={40} height={40} className="w-10 h-10 rounded-full object-cover" />
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

                <label className="block font-medium text-sm mb-1 mt-4 text-[var(--foreground)]">
                  Social Links
                </label>
                <div className="space-y-2 mb-2">
                  {socialLinks.map((link) => {
                    const platform =
                      SOCIAL_PLATFORMS.find((p) => p.id === link.platform) ||
                      SOCIAL_PLATFORMS[SOCIAL_PLATFORMS.length - 1];
                    const Icon = platform.icon;
                    return (
                      <div key={link.id} className="flex items-center gap-2">
                        <div className="input-pill w-[9.5rem] shrink-0">
                          <Icon size={14} className="text-[var(--foreground-secondary)] shrink-0" />
                          <select
                            value={platform.id}
                            onChange={(e) => {
                              const next = SOCIAL_PLATFORMS.find(
                                (p) => p.id === e.target.value
                              );
                              if (!next) return;
                              setSocialLinks((prev) =>
                                prev.map((l) =>
                                  l.id === link.id
                                    ? {
                                        ...l,
                                        platform: next.id,
                                        label:
                                          next.id === "other" && l.platform !== "other"
                                            ? ""
                                            : next.id === "other"
                                            ? l.label
                                            : next.label,
                                      }
                                    : l
                                )
                              );
                            }}
                            className="w-full bg-transparent outline-none text-[var(--foreground)]"
                          >
                            {SOCIAL_PLATFORMS.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        {platform.id === "other" && (
                          <div className="input-pill w-28 shrink-0">
                            <input
                              value={link.label}
                              onChange={(e) =>
                                setSocialLinks((prev) =>
                                  prev.map((l) =>
                                    l.id === link.id ? { ...l, label: e.target.value } : l
                                  )
                                )
                              }
                              type="text"
                              placeholder="Bezeichnung"
                              maxLength={24}
                            />
                          </div>
                        )}
                        <div className="input-pill flex-1">
                          <input
                            value={link.url}
                            onChange={(e) =>
                              setSocialLinks((prev) =>
                                prev.map((l) =>
                                  l.id === link.id ? { ...l, url: e.target.value } : l
                                )
                              )
                            }
                            type="url"
                            placeholder="https://…"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setSocialLinks((prev) => prev.filter((l) => l.id !== link.id))
                          }
                          className="btn-icon w-7 h-7 shrink-0 text-[var(--foreground-secondary)]"
                          aria-label="Link entfernen"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                {socialLinks.length < 8 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSocialLinks((prev) => [
                        ...prev,
                        {
                          id: crypto.randomUUID(),
                          platform: "instagram",
                          label: "Instagram",
                          url: "",
                        },
                      ])
                    }
                    className="btn-secondary text-xs px-2.5 py-1.5"
                  >
                    <Plus size={13} />
                    Link hinzufügen
                  </button>
                )}
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

        <p className="text-center text-xs text-[var(--foreground-secondary)] mt-8">
          Cryptflow v{APP_VERSION}
        </p>
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
      if (user?.id) {
        logSecurityEvent(user.id, "password_changed");
        // Das automatische Schlüssel-Backup ist mit dem ALTEN Passwort
        // verschlüsselt (siehe ensureIdentityAndAutoBackup) — ohne dieses
        // Nachziehen könnte es nach einer Passwort-Änderung nicht mehr
        // entschlüsselt werden.
        exportIdentityBackup(user.id, newPassword).catch((e) =>
          console.error("[SettingsModal] Backup-Aktualisierung nach Passwortwechsel fehlgeschlagen:", e)
        );
      }
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
      if (user?.id) logSecurityEvent(user.id, "mfa_enabled");
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
      if (user?.id) logSecurityEvent(user.id, "mfa_disabled");
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

      <KeyBackupSection />
      <SecurityLogSection />
    </div>
  );
}

/* -----------------------------------------------------------
 * SICHERHEIT: Aktivitätsprotokoll (nur für den eigenen Account einsehbar)
 * ---------------------------------------------------------*/
function SecurityLogSection() {
  const { user } = useUser();
  const [events, setEvents] = useState<(SecurityEvent & { id: string })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    getRecentSecurityEvents(user.id)
      .then((list) => {
        if (!cancelled) setEvents(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (!user?.id || user.isGuest) return null;

  return (
    <div className="pt-6 border-t border-[var(--border-subtle)]">
      <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-2">
        Aktivitätsprotokoll
      </h3>
      <p className="text-xs text-[var(--foreground-secondary)] mb-3">
        Sicherheitsrelevante Aktionen auf diesem Konto — findest du hier etwas,
        das nicht von dir war, ändere umgehend dein Passwort.
      </p>
      {loading ? (
        <p className="text-sm text-[var(--foreground-secondary)]">Lädt…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-[var(--foreground-secondary)]">
          Noch keine Einträge.
        </p>
      ) : (
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {events.map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between px-2 py-1.5 rounded-lg text-sm"
            >
              <span className="text-[var(--foreground)]">
                {labelForSecurityEvent(e.type)}
                {e.detail ? ` · ${e.detail}` : ""}
              </span>
              <span className="text-xs text-[var(--foreground-secondary)] shrink-0 ml-3">
                {new Date(e.createdAt).toLocaleString("de-DE", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -----------------------------------------------------------
 * SICHERHEIT: Schlüssel-Backup (optional, passphrase-verschlüsselt)
 * ---------------------------------------------------------*/
function KeyBackupSection() {
  const { user } = useUser();
  const { showToast } = useToast();
  const [backupInfo, setBackupInfo] = useState<{ createdAt: number } | null | undefined>(
    undefined
  );
  const [showRefresh, setShowRefresh] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    get(ref(db, `encryptedKeyBackup/${user.id}`)).then((snap) => {
      setBackupInfo(snap.exists() ? (snap.val() as { createdAt: number }) : null);
    });
  }, [user?.id]);

  if (!user?.id || user.isGuest) return null;

  async function handleRefresh() {
    if (!user?.id || !auth.currentUser?.email || busy) return;
    setBusy(true);
    try {
      await reauthenticateWithCredential(
        auth.currentUser,
        EmailAuthProvider.credential(auth.currentUser.email, currentPassword)
      );
      await exportIdentityBackup(user.id, currentPassword);
      logSecurityEvent(user.id, "key_backup_created");
      setBackupInfo({ createdAt: Date.now() });
      setShowRefresh(false);
      setCurrentPassword("");
      showToast("Backup aktualisiert.", "success");
    } catch (e) {
      showToast(
        e instanceof Error ? "Passwort falsch oder Aktualisierung fehlgeschlagen." : "Fehlgeschlagen.",
        "error"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pt-6 border-t border-[var(--border-subtle)]">
      <h3 className="text-sm font-semibold text-[var(--foreground-secondary)] uppercase tracking-wide mb-2">
        Schlüssel-Backup
      </h3>
      <p className="text-xs text-[var(--foreground-secondary)] mb-3">
        Deine privaten Schlüssel werden bei jedem Login automatisch gesichert
        (verschlüsselt mit deinem Account-Passwort) — falls dein Browser
        lokale Daten löscht (z. B. nach längerer Inaktivität), stellt die App
        deine Identität beim nächsten Login automatisch wieder her. Kein
        manueller Schritt nötig.
      </p>

      {backupInfo === undefined ? null : backupInfo ? (
        <p className="text-xs text-[var(--foreground-secondary)] mb-3">
          Zuletzt gesichert: {new Date(backupInfo.createdAt).toLocaleString("de-DE")}
        </p>
      ) : (
        <p className="text-xs text-[var(--foreground-secondary)] mb-3">
          Noch kein Backup vorhanden — wird beim nächsten Login automatisch angelegt.
        </p>
      )}

      {!showRefresh ? (
        <button onClick={() => setShowRefresh(true)} className="btn-secondary text-sm">
          Backup jetzt manuell aktualisieren
        </button>
      ) : (
        <div className="space-y-2 max-w-xs">
          <div className="input-pill">
            <input
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              type="password"
              placeholder="Aktuelles Passwort"
              autoComplete="current-password"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setShowRefresh(false);
                setCurrentPassword("");
              }}
              className="btn-secondary text-sm"
            >
              Abbrechen
            </button>
            <button
              onClick={handleRefresh}
              disabled={busy || !currentPassword}
              className="btn-primary text-sm"
            >
              {busy ? "Aktualisiert…" : "Aktualisieren"}
            </button>
          </div>
        </div>
      )}
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
      logSecurityEvent(user.id, "username_changed", clean);
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
  const { sessions, currentSessionId, endSession, staySignedIn, setStaySignedIn } =
    useSession();
  const { showToast } = useToast();
  const [savingStaySignedIn, setSavingStaySignedIn] = useState(false);

  async function handleToggleStaySignedIn() {
    setSavingStaySignedIn(true);
    try {
      await setStaySignedIn(!staySignedIn);
    } catch {
      showToast("Einstellung konnte nicht gespeichert werden.", "error");
    } finally {
      setSavingStaySignedIn(false);
    }
  }

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

      <label className="flex items-start gap-3 px-3 py-2.5 mb-4 rounded-lg bg-[var(--surface-elevated)] border border-[var(--border-subtle)] cursor-pointer">
        <input
          type="checkbox"
          checked={staySignedIn}
          onChange={handleToggleStaySignedIn}
          disabled={savingStaySignedIn}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm text-[var(--foreground)]">
            Dauerhaft angemeldet bleiben
          </span>
          <span className="block text-xs text-[var(--foreground-secondary)] mt-0.5">
            Standardmäßig wirst du nach 30 Minuten Inaktivität automatisch abgemeldet.
            Mit dieser Option bleibt diese Abmeldung deaktiviert.
          </span>
        </span>
      </label>

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
