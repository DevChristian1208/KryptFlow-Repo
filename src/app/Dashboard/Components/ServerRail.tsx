"use client";

import { useState } from "react";
import Image from "next/image";
import { useServer } from "@/app/Context/ServerContext";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import CreateOrJoinServerModal from "./CreateOrJoinServerModal";

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function ServerRail({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
}) {
  const { servers, activeServerId, setActiveServerId } = useServer();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <CreateOrJoinServerModal isOpen={createOpen} onClose={() => setCreateOpen(false)} />

      <aside className="h-full w-[76px] shrink-0 flex flex-col items-center py-4 gap-3 overflow-y-auto">
        {servers.map((s) => {
          const active = s.id === activeServerId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveServerId(s.id)}
              title={s.name}
              aria-current={active}
              className={`relative w-12 h-12 shrink-0 rounded-full flex items-center justify-center transition-transform duration-200 ease-in-out hover:scale-105 ${
                active ? "ring-2 ring-[var(--accent)]" : ""
              }`}
            >
              {s.iconUrl ? (
                <Image
                  src={s.iconUrl}
                  alt={s.name}
                  width={48}
                  height={48}
                  className="rounded-full object-cover"
                />
              ) : (
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-semibold"
                  style={{
                    background: "linear-gradient(135deg, #0a84ff, #0058b8)",
                  }}
                >
                  {initialsFor(s.name)}
                </div>
              )}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          aria-label="Server erstellen oder beitreten"
          title="Server erstellen oder beitreten"
          className="btn-icon w-12 h-12 shrink-0 border border-[var(--border-subtle)] text-[var(--foreground-secondary)]"
        >
          <Plus size={20} />
        </button>

        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label={sidebarOpen ? "Kanalliste einklappen" : "Kanalliste ausklappen"}
            aria-pressed={sidebarOpen}
            className="btn-icon hidden lg:flex w-6 h-6 shrink-0 mt-1 text-[var(--foreground-secondary)]"
          >
            {sidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
      </aside>
    </>
  );
}
