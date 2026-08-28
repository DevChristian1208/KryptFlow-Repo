"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { useUser } from "@/app/Context/UserContext";
import { useServer } from "@/app/Context/ServerContext";

const PENDING_INVITE_KEY = "cryptflow_pending_invite_code";

export default function InvitePage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const { user, loading } = useUser();
  const { joinServerByInviteCode } = useServer();
  const [status, setStatus] = useState<"working" | "error">("working");
  const handled = useRef(false);

  useEffect(() => {
    if (loading || handled.current) return;
    handled.current = true;

    if (!user) {
      // Nicht eingeloggt: Code merken, nach dem Login automatisch
      // konsumieren (siehe Login/page.tsx), dann zum Login weiterleiten.
      try {
        localStorage.setItem(PENDING_INVITE_KEY, params.code);
      } catch {}
      router.replace("/Login");
      return;
    }

    (async () => {
      try {
        await joinServerByInviteCode(params.code);
        router.replace("/Dashboard");
      } catch {
        setStatus("error");
      }
    })();
  }, [loading, user, params.code, joinServerByInviteCode, router]);

  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center px-4">
      <div className="card-surface w-full max-w-sm p-8 text-center">
        <Image
          src="/Logo.svg"
          alt="Cryptflow Logo"
          width={64}
          height={64}
          className="mx-auto mb-5"
        />
        {status === "working" ? (
          <p className="text-[var(--foreground-secondary)]">
            Einladung wird verarbeitet…
          </p>
        ) : (
          <>
            <p className="text-[var(--foreground)] font-medium mb-2">
              Dieser Einladungslink konnte nicht verwendet werden.
            </p>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Er ist möglicherweise abgelaufen, aufgebraucht oder ungültig.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export { PENDING_INVITE_KEY };
