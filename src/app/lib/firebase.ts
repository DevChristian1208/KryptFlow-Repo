import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "firebase/app-check";
import {
  getAnalytics,
  isSupported as analyticsIsSupported,
} from "firebase/analytics";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// App Check: erschwert, die (zwangsläufig öffentliche, weil client-seitige)
// Firebase-Config aus einem fremden Skript heraus direkt gegen unsere
// RTDB/Storage zu verwenden statt über diese App — Anfragen ohne gültiges
// App-Check-Token werden abgelehnt, SOBALD Enforcement in der Firebase
// Console für Realtime Database/Storage aktiviert ist (siehe README-Hinweis
// unten, das ist ein manueller Schritt in der Console, kein Code).
// Ohne gesetzten Site-Key bewusst übersprungen statt mit einem leeren String
// zu initialisieren — sonst würde jede Anfrage bis zur Console-Aktivierung
// von App Check grundlos ein ungültiges Token mitschicken.
const appCheckSiteKey = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY;
if (typeof window !== "undefined" && appCheckSiteKey) {
  if (process.env.NODE_ENV !== "production") {
    // Lokale Entwicklung: reCAPTCHA v3 kennt "localhost" nicht als gültige
    // Domain. Der Debug-Token wird beim ersten Start in der Browser-Konsole
    // ausgegeben und muss einmalig unter Firebase Console -> App Check ->
    // Debug-Tokens verwalten eingetragen werden.
    (window as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (e) {
    console.error("[firebase] App Check konnte nicht initialisiert werden:", e);
  }
}

export let analytics: import("firebase/analytics").Analytics | null = null;
if (typeof window !== "undefined") {
  analyticsIsSupported().then((ok) => {
    if (ok) {
      try {
        analytics = getAnalytics(app);
      } catch {
      }
    }
  });
}
