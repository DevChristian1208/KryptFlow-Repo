import { ref, push, query, orderByChild, limitToLast, get } from "firebase/database";
import { db } from "@/app/lib/firebase";

export type SecurityEventType =
  | "login"
  | "password_changed"
  | "mfa_enabled"
  | "mfa_disabled"
  | "key_backup_created"
  | "key_backup_restored"
  | "server_deleted"
  | "username_changed";

export type SecurityEvent = {
  type: SecurityEventType;
  detail?: string;
  createdAt: number;
  userAgent?: string;
};

const LABELS: Record<SecurityEventType, string> = {
  login: "Anmeldung",
  password_changed: "Passwort geändert",
  mfa_enabled: "Zwei-Faktor-Authentifizierung aktiviert",
  mfa_disabled: "Zwei-Faktor-Authentifizierung deaktiviert",
  key_backup_created: "Schlüssel-Backup erstellt",
  key_backup_restored: "Schlüssel aus Backup wiederhergestellt",
  server_deleted: "Server gelöscht",
  username_changed: "Benutzername geändert",
};

export function labelForSecurityEvent(type: SecurityEventType): string {
  return LABELS[type] || type;
}

/**
 * Selbst-Audit-Log, nur für den eigenen Account lesbar (siehe
 * database.rules.json: securityLog/{uid}) — kein Cloud-Functions-Backend
 * verfügbar, daher rein clientseitig ausgelöst bei sicherheitsrelevanten
 * Aktionen dieses Nutzers selbst. Best-effort/fire-and-forget: ein
 * Fehlschlag beim Protokollieren darf die eigentliche Aktion nie blockieren.
 */
export function logSecurityEvent(
  uid: string,
  type: SecurityEventType,
  detail?: string
): void {
  const event: SecurityEvent = {
    type,
    ...(detail ? { detail } : {}),
    createdAt: Date.now(),
    ...(typeof navigator !== "undefined" ? { userAgent: navigator.userAgent } : {}),
  };
  push(ref(db, `securityLog/${uid}`), event).catch((e) =>
    console.error("[securityLog] Eintrag konnte nicht gespeichert werden:", e)
  );
}

export async function getRecentSecurityEvents(
  uid: string,
  count = 20
): Promise<(SecurityEvent & { id: string })[]> {
  const q = query(ref(db, `securityLog/${uid}`), orderByChild("createdAt"), limitToLast(count));
  const snap = await get(q);
  const val = (snap.val() as Record<string, SecurityEvent> | null) || {};
  return Object.entries(val)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
