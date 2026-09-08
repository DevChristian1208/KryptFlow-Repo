// Reiner In-Memory-Zwischenspeicher (nie persistiert), get-and-clear
// Semantik. Login/page.tsx setzt ihn VOR signInWithEmailAndPassword (siehe
// Kommentar dort zur Race Condition mit onAuthStateChanged), UserContext.tsx
// konsumiert ihn einmalig für das automatische Schlüssel-Backup.

let pending: string | null = null;

export function setPendingLoginPassword(password: string): void {
  pending = password;
}

export function consumePendingLoginPassword(): string | null {
  const value = pending;
  pending = null;
  return value;
}
