import { NextRequest, NextResponse } from "next/server";

// Next.js' offizielles Nonce-Muster für CSP: da Next.js selbst mehrere
// Inline-<script>-Tags pro Seite injiziert (RSC-Hydration-Payload, pro Seite
// unterschiedlicher Inhalt), lässt sich script-src NICHT mit einem
// statischen Hash abdecken (siehe vorheriger next.config.ts-Versuch — hat
// die App komplett blockiert). Stattdessen: pro Request eine frische Nonce
// erzeugen, sowohl als Response-Header (für den Browser) als auch als
// Request-Header (damit layout.tsx sie per next/headers auslesen und dem
// eigenen Theme-Flash-Script mitgeben kann). 'strict-dynamic' lässt von
// einem bereits nonce-vertrauten Script (z. B. unseren eigenen _next/static-
// Chunks) dynamisch nachgeladene Scripts (z. B. das reCAPTCHA-Script, das
// die Firebase-App-Check-SDK zur Laufzeit selbst einfügt) automatisch zu,
// ohne dass jedes einzeln eine eigene Nonce bräuchte.
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // Next.js' Dev-Modus (Turbopack/React Fast Refresh) wertet selbst Code per
  // eval()/new Function() aus (Source-Map- bzw. Hot-Reload-Mechanik) — ohne
  // 'unsafe-eval' bricht das lokale `next dev` komplett (leerer
  // "Application error"-Screen). Nur im Produktions-Build (next build/start,
  // also auch der Vercel-Deploy) greift die strikte Variante ohne eval.
  const isDev = process.env.NODE_ENV !== "production";

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""} https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://lh3.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.firebasedatabase.app wss://*.firebasedatabase.app https://content-firebaseappcheck.googleapis.com https://www.google-analytics.com https://region1.google-analytics.com",
    "frame-src https://www.google.com/recaptcha/",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Auf alle Seiten anwenden außer statische Assets/Bilder — dort bringt
    // eine CSP nichts und würde nur unnötig Overhead pro Request erzeugen.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
