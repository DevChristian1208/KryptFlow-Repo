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

// Ohne gesetzten Site-Key bewusst übersprungen statt mit leerem String zu
// initialisieren — Enforcement wird separat und manuell in der Firebase
// Console aktiviert.
const appCheckSiteKey = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY;
if (typeof window !== "undefined" && appCheckSiteKey) {
  if (process.env.NODE_ENV !== "production") {
    // reCAPTCHA v3 kennt "localhost" nicht als gültige Domain — der
    // Debug-Token landet in der Browser-Konsole und muss einmalig unter
    // Firebase Console -> App Check -> Debug-Tokens eingetragen werden.
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
