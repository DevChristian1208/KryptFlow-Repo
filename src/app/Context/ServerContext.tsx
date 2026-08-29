"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import {
  ref,
  onValue,
  off,
  set,
  get,
  update,
  runTransaction,
} from "firebase/database";
import { db } from "@/app/lib/firebase";
import { useUser } from "./UserContext";
import { useToast } from "./ToastContext";
import { logSecurityEvent } from "@/app/lib/securityLog";

export type ServerRole = "owner" | "admin" | "member";

export type Server = {
  id: string;
  name: string;
  iconUrl?: string;
  bannerUrl?: string;
  ownerUid: string;
  createdAt: number;
  myRole: ServerRole;
};

type ServerDb = {
  name?: string;
  iconUrl?: string;
  bannerUrl?: string;
  ownerUid?: string;
  createdAt?: number;
};

type ServerInviteDb = {
  serverId: string;
  createdByUid: string;
  createdAt: number;
  expiresAt?: number;
  maxUses?: number;
  useCount?: number;
};

type ServerContextType = {
  servers: Server[];
  activeServerId: string | null;
  activeServer: Server | null;
  setActiveServerId: (id: string | null) => void;
  createServer: (name: string, iconUrl?: string) => Promise<string>;
  createInvite: (
    serverId: string,
    opts?: { expiresInMs?: number; maxUses?: number }
  ) => Promise<string>;
  joinServerByInviteCode: (code: string, uidOverride?: string) => Promise<boolean>;
  inviteUserToServer: (
    serverId: string,
    serverName: string,
    targetUid: string
  ) => Promise<void>;
  renameServer: (serverId: string, name: string) => Promise<void>;
  updateServerBanner: (serverId: string, bannerUrl: string) => Promise<void>;
  updateServerIcon: (serverId: string, iconUrl: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  updateMemberRole: (
    serverId: string,
    uid: string,
    role: ServerRole
  ) => Promise<void>;
  removeMember: (serverId: string, uid: string) => Promise<void>;
  leaveServer: (serverId: string) => Promise<void>;
  loading: boolean;
};

const ServerContext = createContext<ServerContextType | undefined>(undefined);

export function ServerProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const { showToast } = useToast();

  const [servers, setServers] = useState<Server[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Eigene Server laden: userServers/{uid} liefert die IDs, servers/{id} +
  // serverMembers/{id}/{uid} liefern Details/Rolle — analog zum dmThreads-
  // Muster in DirectContext.tsx.
  useEffect(() => {
    if (!user?.id) {
      setServers([]);
      setActiveServerId(null);
      return;
    }

    const r = ref(db, `userServers/${user.id}`);
    const unsub = onValue(r, (snap) => {
      const ids = Object.keys((snap.val() as Record<string, true> | null) || {});

      (async () => {
        const list = await Promise.all(
          ids.map(async (id) => {
            const [serverSnap, memberSnap] = await Promise.all([
              get(ref(db, `servers/${id}`)),
              get(ref(db, `serverMembers/${id}/${user.id}`)),
            ]);
            if (!serverSnap.exists()) return null;
            const s = serverSnap.val() as ServerDb;
            const role =
              (memberSnap.val() as { role?: ServerRole } | null)?.role || "member";
            const server: Server = {
              id,
              name: s.name || "Unbenannter Server",
              iconUrl: s.iconUrl,
              bannerUrl: s.bannerUrl,
              ownerUid: s.ownerUid || "",
              createdAt: s.createdAt || 0,
              myRole: role,
            };
            return server;
          })
        );
        const resolved = list.filter((s): s is Server => s !== null);
        resolved.sort((a, b) => a.createdAt - b.createdAt);
        setServers(resolved);

        setActiveServerId((prev) => {
          if (prev && resolved.find((s) => s.id === prev)) return prev;
          return resolved[0]?.id || null;
        });
      })();
    });

    return () => off(r, "value", unsub);
  }, [user?.id]);

  const activeServer = servers.find((s) => s.id === activeServerId) || null;

  const createServer = useCallback(
    async (name: string, iconUrl?: string): Promise<string> => {
      if (!user?.id) throw new Error("Nicht eingeloggt.");
      const clean = name.trim();
      if (!clean) throw new Error("Ungültiger Server-Name.");

      setLoading(true);
      try {
        const serverId = crypto.randomUUID();
        const createdAt = Date.now();
        // Zwei getrennte Aufrufe: die Owner-Selbstschreibrechte für
        // serverMembers/{serverId}/{uid} prüfen servers/{serverId}.ownerUid
        // — dieser Pfad darf deshalb nicht im selben Mehrfach-
        // Schreibvorgang erst angelegt werden (Cross-Path-Problem).
        await set(ref(db, `servers/${serverId}`), {
          name: clean,
          ...(iconUrl ? { iconUrl } : {}),
          ownerUid: user.id,
          createdAt,
        });
        await update(ref(db), {
          [`serverMembers/${serverId}/${user.id}`]: {
            role: "owner",
            joinedAt: createdAt,
          },
          [`userServers/${user.id}/${serverId}`]: true,
        });
        // Rate-Limit-Zeitstempel erst NACH der eigentlichen Aktion und in
        // einem eigenen Aufruf setzen — die servers/{id}-Regel liest diesen
        // Pfad, ein gleichzeitiges Schreiben im selben Mehrfach-
        // Schreibvorgang wäre wieder das Cross-Path-Problem.
        update(ref(db), { [`rateLimits/${user.id}/createServer`]: createdAt }).catch(() => {});
        setActiveServerId(serverId);
        return serverId;
      } catch (e) {
        console.error("[ServerContext] createServer fehlgeschlagen:", e);
        if (e instanceof Error && /permission_denied/i.test(e.message)) {
          throw new Error("Bitte kurz warten, bevor du einen weiteren Server erstellst.");
        }
        throw new Error("Server konnte nicht erstellt werden.");
      } finally {
        setLoading(false);
      }
    },
    [user?.id]
  );

  const createInvite = useCallback(
    async (
      serverId: string,
      opts?: { expiresInMs?: number; maxUses?: number }
    ): Promise<string> => {
      if (!user?.id) throw new Error("Nicht eingeloggt.");
      const code = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      const invite: ServerInviteDb = {
        serverId,
        createdByUid: user.id,
        createdAt: Date.now(),
        useCount: 0,
        ...(opts?.expiresInMs ? { expiresAt: Date.now() + opts.expiresInMs } : {}),
        ...(opts?.maxUses ? { maxUses: opts.maxUses } : {}),
      };
      try {
        await set(ref(db, `serverInvites/${code}`), invite);
        update(ref(db), { [`rateLimits/${user.id}/createInvite`]: Date.now() }).catch(() => {});
        return code;
      } catch (e) {
        console.error("[ServerContext] createInvite fehlgeschlagen:", e);
        if (e instanceof Error && /permission_denied/i.test(e.message)) {
          throw new Error("Bitte kurz warten, bevor du einen weiteren Einladungslink erstellst.");
        }
        throw new Error("Einladungslink konnte nicht erstellt werden.");
      }
    },
    [user?.id]
  );

  const joinServerByInviteCode = useCallback(
    async (code: string, uidOverride?: string): Promise<boolean> => {
      // uidOverride erlaubt den Aufruf direkt nach dem Login (Login/page.tsx):
      // dort ist setUser(...) zwar schon aufgerufen, aber der React-State
      // (und damit user.id in diesem Closure) aktualisiert sich erst beim
      // nächsten Rendern — ohne die bereits bekannte uid explizit
      // durchzureichen, würde die Prüfung unten fälschlich "nicht eingeloggt"
      // auslösen, obwohl die Anmeldung gerade erfolgreich war.
      const uid = uidOverride || user?.id;
      if (!uid) throw new Error("Nicht eingeloggt.");
      const cleanCode = code.trim().split("/").pop() || code.trim();

      // Rückgabewert (statt nur Toast + return) nötig, damit Aufrufer
      // (invite/[code]/page.tsx, CreateOrJoinServerModal.tsx) einen
      // ungültigen/abgelaufenen/aufgebrauchten Link nicht fälschlich als
      // Erfolg behandeln (z. B. Weiterleitung ins Dashboard oder Schließen
      // des Modals, obwohl gar kein Beitritt stattgefunden hat).
      const snap = await get(ref(db, `serverInvites/${cleanCode}`));
      if (!snap.exists()) {
        showToast("Dieser Einladungslink ist ungültig.", "error");
        return false;
      }
      const invite = snap.val() as ServerInviteDb;
      if (invite.expiresAt && Date.now() > invite.expiresAt) {
        showToast("Dieser Einladungslink ist abgelaufen.", "error");
        return false;
      }
      if (invite.maxUses && (invite.useCount || 0) >= invite.maxUses) {
        showToast("Dieser Einladungslink wurde bereits zu oft verwendet.", "error");
        return false;
      }

      const alreadyMember = await get(
        ref(db, `serverMembers/${invite.serverId}/${uid}`)
      );
      if (alreadyMember.exists()) {
        setActiveServerId(invite.serverId);
        showToast("Du bist bereits Mitglied dieses Servers.", "info");
        return true;
      }

      try {
        await update(ref(db), {
          [`serverMembers/${invite.serverId}/${uid}`]: {
            role: "member",
            joinedAt: Date.now(),
          },
          [`userServers/${uid}/${invite.serverId}`]: true,
        });
        // Der eigentliche Beitritt ist an dieser Stelle bereits
        // abgeschlossen — Erfolg unabhängig vom Nutzungszähler zeigen, statt
        // eine spätere, rein kosmetische Zähler-Schreibung den Erfolg
        // fälschlich als Fehlschlag erscheinen zu lassen.
        setActiveServerId(invite.serverId);
        showToast("Server beigetreten.", "success");
        // Nutzungszähler bestmöglich nachführen (kein hartes Limit-Enforcement
        // in den Rules, wie beim Rate-Limiting bewusst offengelegt).
        runTransaction(
          ref(db, `serverInvites/${cleanCode}/useCount`),
          (current) => (current || 0) + 1
        ).catch(() => {});
        update(ref(db), { [`rateLimits/${uid}/joinServer`]: Date.now() }).catch(() => {});
        return true;
      } catch (e) {
        console.error("[ServerContext] joinServerByInviteCode fehlgeschlagen:", e);
        const denied = e instanceof Error && /permission_denied/i.test(e.message);
        showToast(
          denied
            ? "Bitte kurz warten, bevor du erneut einem Server beitrittst."
            : "Beitreten fehlgeschlagen. Bitte erneut versuchen.",
          "error"
        );
        return false;
      }
    },
    [user?.id, showToast]
  );

  const inviteUserToServer = useCallback(
    async (serverId: string, serverName: string, targetUid: string): Promise<void> => {
      if (!user?.id) throw new Error("Nicht eingeloggt.");
      try {
        await set(ref(db, `serverDirectInvites/${targetUid}/${serverId}`), {
          serverId,
          serverName,
          byUid: user.id,
          byName: user.name || "Unbekannt",
          createdAt: Date.now(),
        });
      } catch (e) {
        console.error("[ServerContext] inviteUserToServer fehlgeschlagen:", e);
        throw new Error("Einladung konnte nicht gesendet werden.");
      }
    },
    [user?.id, user?.name]
  );

  const renameServer = useCallback(
    async (serverId: string, name: string): Promise<void> => {
      const clean = name.trim();
      if (!clean) return;
      await update(ref(db, `servers/${serverId}`), { name: clean });
    },
    []
  );

  const updateServerBanner = useCallback(
    async (serverId: string, bannerUrl: string): Promise<void> => {
      await update(ref(db, `servers/${serverId}`), { bannerUrl });
    },
    []
  );

  const updateServerIcon = useCallback(
    async (serverId: string, iconUrl: string): Promise<void> => {
      await update(ref(db, `servers/${serverId}`), { iconUrl });
    },
    []
  );

  const deleteServer = useCallback(async (serverId: string): Promise<void> => {
    if (!user?.id) throw new Error("Nicht eingeloggt.");
    const ownerUid = user.id;

    const membersSnap = await get(ref(db, `serverMembers/${serverId}`));
    const memberUids = Object.keys(
      (membersSnap.val() as Record<string, unknown> | null) || {}
    );
    const chansSnap = await get(ref(db, "channels"));
    const chans = (chansSnap.val() as Record<string, { serverId?: string }> | null) || {};
    const channelIds = Object.entries(chans)
      .filter(([, c]) => c.serverId === serverId)
      .map(([id]) => id);

    // Drei getrennte, sequenzielle update()-Aufrufe statt einem: mehrere der
    // betroffenen Rules lesen den Pfad, der gerade in DEMSELBEN
    // Mehrfach-Schreibvorgang gelöscht wird (z. B. channelKeys/{cid}s Regel
    // liest channels/{cid}.serverId, während channels/{cid} selbst mitgelöscht
    // würde) — genau das Muster, das sich bei den Rate-Limiting-Regeln in
    // dieser Session bereits als unzuverlässig erwiesen hat. Deshalb erst die
    // Blätter (Nachrichten/Schlüssel), dann die Kanäle, dann zuletzt den
    // Server/die Mitgliederliste selbst löschen.
    try {
      const leafUpdates: Record<string, null> = {};
      for (const cid of channelIds) {
        leafUpdates[`channelMessages/${cid}`] = null;
        leafUpdates[`channelMessageReactions/${cid}`] = null;
        leafUpdates[`channelThreadReplies/${cid}`] = null;
        leafUpdates[`channelKeys/${cid}`] = null;
        leafUpdates[`channelKeyEpochs/${cid}`] = null;
      }
      if (Object.keys(leafUpdates).length > 0) {
        await update(ref(db), leafUpdates);
      }

      const channelAndIndexUpdates: Record<string, null> = {};
      for (const cid of channelIds) {
        channelAndIndexUpdates[`channels/${cid}`] = null;
      }
      for (const uid of memberUids) {
        channelAndIndexUpdates[`userServers/${uid}/${serverId}`] = null;
      }
      if (Object.keys(channelAndIndexUpdates).length > 0) {
        await update(ref(db), channelAndIndexUpdates);
      }

      // servers/{serverId} zuerst allein löschen — dessen Löschregel liest
      // serverMembers/{serverId}/{ownerUid}, das deshalb in diesem Aufruf
      // noch unangetastet sein muss.
      await update(ref(db), { [`servers/${serverId}`]: null });

      // Die übrigen Mitglieder zuerst gemeinsam entfernen: ihre Löschregel
      // liest den (noch unveränderten) eigenen Owner-Eintrag von auth.uid.
      // Den eigenen Owner-Eintrag danach für sich allein löschen — Selbstbezug
      // auf den eigenen Vor-Schreib-Zustand ist zuverlässig, anders als ein
      // Querverweis auf einen fremden Pfad, der im selben Mehrfach-
      // Schreibvorgang gerade mitgeändert wird.
      const otherMemberUpdates: Record<string, null> = {};
      for (const uid of memberUids) {
        if (uid !== ownerUid) {
          otherMemberUpdates[`serverMembers/${serverId}/${uid}`] = null;
        }
      }
      if (Object.keys(otherMemberUpdates).length > 0) {
        await update(ref(db), otherMemberUpdates);
      }
      await update(ref(db), { [`serverMembers/${serverId}/${ownerUid}`]: null });
      logSecurityEvent(ownerUid, "server_deleted", serverId);
    } catch (e) {
      console.error("[ServerContext] deleteServer fehlgeschlagen:", e);
      throw new Error("Server konnte nicht gelöscht werden.");
    }
  }, [user?.id]);

  const updateMemberRole = useCallback(
    async (serverId: string, uid: string, role: ServerRole): Promise<void> => {
      await update(ref(db, `serverMembers/${serverId}/${uid}`), { role });
    },
    []
  );

  const removeMember = useCallback(
    async (serverId: string, uid: string): Promise<void> => {
      await update(ref(db), {
        [`serverMembers/${serverId}/${uid}`]: null,
        [`userServers/${uid}/${serverId}`]: null,
      });
    },
    []
  );

  const leaveServer = useCallback(
    async (serverId: string): Promise<void> => {
      if (!user?.id) throw new Error("Nicht eingeloggt.");
      // Owner können den Server nicht einfach verlassen (Rule verbietet
      // das explizit) — sie müssten ihn löschen oder (noch nicht gebaut)
      // die Eigentümerschaft zuvor übertragen.
      await update(ref(db), {
        [`serverMembers/${serverId}/${user.id}`]: null,
        [`userServers/${user.id}/${serverId}`]: null,
      });
      if (activeServerId === serverId) setActiveServerId(null);
    },
    [user?.id, activeServerId]
  );

  return (
    <ServerContext.Provider
      value={{
        servers,
        activeServerId,
        activeServer,
        setActiveServerId,
        createServer,
        createInvite,
        joinServerByInviteCode,
        inviteUserToServer,
        renameServer,
        updateServerBanner,
        updateServerIcon,
        deleteServer,
        updateMemberRole,
        removeMember,
        leaveServer,
        loading,
      }}
    >
      {children}
    </ServerContext.Provider>
  );
}

export function useServer() {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServer must be used within a ServerProvider");
  return ctx;
}
