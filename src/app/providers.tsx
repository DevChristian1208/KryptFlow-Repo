"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/app/lib/firebase";
import { UserProvider } from "./Context/UserContext";
import { ServerProvider } from "./Context/ServerContext";
import { ChannelProvider } from "./Context/ChannelContext";
import { DirectProvider } from "./Context/DirectContext";
import { ToastProvider } from "./Context/ToastContext";
import { PresenceProvider } from "./Context/PresenceContext";
import { NotificationProvider } from "./Context/NotificationContext";
import { ThemeProvider } from "./Context/ThemeContext";
import { SessionProvider } from "./Context/SessionContext";
import { ProfileDialogProvider } from "./Context/ProfileDialogContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, () => {
      setReady(true);
    });
    return () => unsub();
  }, []);

  if (!ready) return null;

  return (
    <ThemeProvider>
      <ToastProvider>
        <UserProvider>
          <PresenceProvider>
            <SessionProvider>
              <NotificationProvider>
                <ServerProvider>
                  <ChannelProvider>
                    <DirectProvider>
                      <ProfileDialogProvider>{children}</ProfileDialogProvider>
                    </DirectProvider>
                  </ChannelProvider>
                </ServerProvider>
              </NotificationProvider>
            </SessionProvider>
          </PresenceProvider>
        </UserProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
