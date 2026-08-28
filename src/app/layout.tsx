import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Cryptflow",
  description: "Slack-ähnlicher Chat mit Channels und Direktnachrichten",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de" suppressHydrationWarning>
      <head>
        <script
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
