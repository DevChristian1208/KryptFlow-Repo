import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Cryptflow",
  description: "Slack-ähnlicher Chat mit Channels und Direktnachrichten",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Von src/middleware.ts pro Request gesetzt — erlaubt diesem einen
  // Inline-Script, trotz strikter CSP (script-src mit Nonce statt
  // 'unsafe-inline') zu laufen.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="de" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          // Browser lesen den nonce-Attributwert per Design nie über das DOM
          // zurück (Schutz gegen Auslesen via XSS) — dadurch weicht der vom
          // Server gerenderte Wert immer vom beim Hydrieren gelesenen
          // (leeren) Wert ab. Bekannte, folgenlose Next.js/React-Eigenheit
          // bei diesem Muster, siehe Next.js-CSP-Doku.
          suppressHydrationWarning
          // Setzt das Theme-Attribut vor dem ersten Paint, damit beim Laden
          // kein kurzes Aufblitzen im falschen Farbschema sichtbar ist.
          dangerouslySetInnerHTML={{
            __html: `try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}`,
          }}
        />
      </head>
      <body className="min-h-screen bg-[var(--background)]" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
