"use client";

import Image from "next/image";
import { useUser } from "@/app/Context/UserContext";
import { useTheme } from "@/app/Context/ThemeContext";
import { usePresence } from "@/app/Context/PresenceContext";
import { useSession } from "@/app/Context/SessionContext";
import { useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { signOut } from "firebase/auth";
import { auth } from "@/app/lib/firebase";
import { Menu, ChevronDown, Sun, Moon } from "lucide-react";
import SettingsModal from "./SettingsModal";
import InvitesPanel from "./InvitesPanel";

export default function Header({
  onToggleHeader,
}: {
  onToggleHeader?: () => void;
}) {
  const { user } = useUser();
  const { theme, toggleTheme } = useTheme();
  const { signOutPresence } = usePresence();
  const { endCurrentSession } = useSession();
  const [dropDown, setDropDown] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement | null>(null);

  async function handleLogout() {
    try {
      setDropDown(false);
      await signOutPresence();
      await endCurrentSession();
      await signOut(auth);
      router.push("/Login");
    } catch (error) {
      console.log(error);
    }
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setDropDown(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="w-full h-[64px] md:h-[70px] px-3 md:px-10 bg-[var(--background)] flex items-center justify-between relative z-30">
      <div className="flex items-center gap-3 min-w-[120px]">
        <button
          type="button"
          onClick={onToggleHeader}
          className="btn-icon lg:hidden w-10 h-10 bg-[var(--surface-elevated)] border border-[var(--border-subtle)] shadow-sm"
          aria-label="Menü öffnen"
        >
          <Menu size={20} />
        </button>

        <div className="flex items-center gap-2">
          <Image src="/Logo.svg" alt="Logo" width={32} height={32} />
          <span className="text-base md:text-lg font-semibold text-[var(--foreground)]">
            Cryptflow
          </span>
        </div>
      </div>
      <div className="hidden md:flex flex-1 justify-center"></div>
      <div
        className="flex items-center gap-2 font-medium text-sm min-w-[120px] justify-end relative"
        ref={menuRef}
      >
        <button
          type="button"
          onClick={toggleTheme}
          className="btn-icon w-9 h-9 text-[var(--foreground-secondary)]"
          aria-label={
            theme === "dark" ? "Zu hellem Design wechseln" : "Zu dunklem Design wechseln"
          }
          title={theme === "dark" ? "Helles Design" : "Dunkles Design"}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <InvitesPanel />

        <span className="hidden sm:inline text-[var(--foreground)]">
          {user?.name}
        </span>
        <Image
          src={user?.avatar || "/avatar1.png"}
          alt="avatar"
          width={32}
          height={32}
          className="rounded-full"
        />
        <button
          type="button"
          onClick={() => setDropDown((prev) => !prev)}
          className="btn-icon w-7 h-7 text-[var(--foreground-secondary)]"
          aria-label="Menü umschalten"
          aria-expanded={dropDown}
        >
          <ChevronDown
            size={18}
            className={`transition-transform ${dropDown ? "rotate-180" : ""}`}
          />
        </button>

        {dropDown && (
          <div className="card-surface absolute right-0 top-12 w-56 p-6 flex flex-col gap-6 z-40">
            <button
              onClick={() => {
                setDropDown(false);
                setSettingsOpen(true);
              }}
              className="text-lg font-medium text-left text-[var(--foreground)] hover:opacity-80 cursor-pointer"
            >
              Einstellungen
            </button>
            <button
              onClick={handleLogout}
              className="text-lg font-medium text-left text-[var(--foreground)] hover:opacity-80 cursor-pointer"
            >
              Log out
            </button>
          </div>
        )}
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
