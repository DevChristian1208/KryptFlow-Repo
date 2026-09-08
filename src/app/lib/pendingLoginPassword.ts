// Reiner In-Memory-Zwischenspeicher (nie persistiert, kein localStorage/
// sessionStorage) für das gerade eingegebene Login-Passwort — Login/page.tsx
// setzt ihn direkt vor/nach signInWithEmailAndPassword, UserContext.tsx
// liest ihn im selben Tab-Leben einmalig aus seinem onAuthStateChanged-
// Handler, um das automatische, passwortbasierte Schlüssel-Backup
// durchzuführen (siehe ensureIdentityAndAutoBackup in crypto.ts). Ein
// bloßer Seiten-Reload mit bereits bestehender Sitzung hat kein Passwort
// zur Verfügung — dafür bleibt der interaktive Wiederherstellungs-Dialog
// als Fallback bestehen.

let pending: string | null = null;

export function setPendingLoginPassword(password: string): void {
  pending = password;
}

export function consumePendingLoginPassword(): string | null {
  const value = pending;
  pending = null;
  return value;
}
