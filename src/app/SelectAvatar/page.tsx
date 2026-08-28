"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db } from "@/app/lib/firebase";
import { ref, set } from "firebase/database";
import { Upload } from "lucide-react";
import { useUser } from "../Context/UserContext";
import { useToast } from "../Context/ToastContext";
import { uploadImage, ImageValidationError } from "../lib/uploadImage";

export default function SelectAvatar() {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const isFormComplete = avatarUrl !== null && name.trim() !== "";

  const { user, setUser } = useUser();
  const { showToast } = useToast();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!user) {
      router.replace("/Login");
      return;
    }
    // Der Name wird bewusst NICHT vorausgefüllt (auch nicht aus E-Mail oder
    // Anzeigenamen) — der Nutzer soll ihn hier immer selbst eingeben.
    setEmail(user.isGuest ? "" : user.email || "");
  }, [user, router]);

  const avatars = [
    "/avatar1.png",
    "/avatar2.png",
    "/avatar3.png",
    "/avatar4.png",
    "/avatar5.png",
    "/avatar6.png",
  ];

  const handleFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (
    e
  ) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;

    setUploading(true);
    try {
      const url = await uploadImage(file, `avatars/${user.id}_${Date.now()}`);
      setAvatarUrl(url);
    } catch (err) {
      console.error("[SelectAvatar] Avatar-Upload fehlgeschlagen:", err);
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

  async function saveAndGo() {
    if (!user?.id || saving || !isFormComplete) return;
    const avatar = avatarUrl!;
    const cleanName = name.trim();
    setSaving(true);

    try {
      await set(ref(db, `newusers/${user.id}`), {
        authUid: user.id,
        newname: cleanName,
        newemail: user.isGuest ? "" : user.email,
        avatar,
        isGuest: user.isGuest,
        ...(typeof window !== "undefined" && localStorage.getItem("username")
          ? { username: localStorage.getItem("username") }
          : {}),
      });

      setUser({
        id: user.id,
        name: cleanName,
        email: email,
        avatar,
        isGuest: user.isGuest,
      });

      router.push("/Dashboard");
    } catch (e) {
      console.error("[SelectAvatar] Speichern fehlgeschlagen:", e);
      showToast("Speichern fehlgeschlagen. Bitte erneut versuchen.", "error");
    } finally {
      setSaving(false);
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

      <div className="absolute bottom-11 w-full flex justify-center gap-6 text-sm text-[var(--foreground-secondary)] px-4">
        <Link href="/ImpressumundDatenschutz/LegalNotice" className="hover:underline">
          Impressum
        </Link>
        <Link href="/ImpressumundDatenschutz/PrivacyPolicy" className="hover:underline">
          Datenschutz
        </Link>
      </div>

      <div className="flex justify-center items-center min-h-screen">
        <div className="card-surface relative w-full max-w-sm p-8 space-y-6 mt-12 text-center">
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Wähle deinen Avatar
          </h1>

          <div className="w-24 h-24 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] mx-auto flex items-center justify-center overflow-hidden relative">
            <Image
              src={avatarUrl || "/81. Profile.png"}
              alt="Ausgewählter Avatar"
              fill
              className="object-cover"
            />
          </div>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="btn-secondary text-sm mx-auto"
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

          <div className="input-pill">
            <input
              type="text"
              placeholder="Gib deinen Namen ein"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex justify-center gap-3">
            {avatars.map((src, index) => (
              <button
                key={index}
                onClick={() => setAvatarUrl(src)}
                className={`w-10 h-10 rounded-full border-2 transition ${
                  avatarUrl === src
                    ? "border-[var(--accent)]"
                    : "border-transparent"
                }`}
              >
                <Image
                  src={src}
                  alt={`Avatar ${index + 1}`}
                  width={40}
                  height={40}
                  className="rounded-full"
                />
              </button>
            ))}
          </div>

          <button
            onClick={saveAndGo}
            disabled={!isFormComplete || saving}
            className="btn-primary w-full mt-2"
          >
            {saving ? "Speichern..." : "Weiter"}
          </button>
        </div>
      </div>
    </div>
  );
}
