"use client";

import Image from "next/image";
import Link from "next/link";

export default function LegalNotice() {
  return (
    <div className="min-h-screen bg-[var(--background)] relative overflow-x-hidden">
      <div className="px-4 pt-6">
        <div className="absolute top-6 left-6 flex items-center gap-2">
          <Image src="/Logo.svg" alt="Logo" width={30} height={30} />
          <span className="text-lg font-semibold text-[var(--foreground)]">
            Cryptflow
          </span>
        </div>

        <div className="absolute top-6 right-6 text-sm text-[var(--foreground-secondary)] flex flex-col items-end">
          <span className="hidden sm:block">Neu bei Cryptflow?</span>
          <Link
            href="/Newuser"
            className="text-[var(--accent)] font-medium hover:underline"
          >
            Konto erstellen
          </Link>
        </div>
      </div>

      <main className="px-4 pb-16 pt-24">
        <div className="card-surface mx-auto w-full max-w-3xl p-6 sm:p-8 text-[var(--foreground)]">
          <header className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold text-[var(--foreground)]">
              Impressum
            </h1>
            <p className="mt-1 text-sm text-[var(--foreground-secondary)]">
              Stand: August 2026
            </p>
          </header>

          <section className="prose prose-gray max-w-none prose-headings:scroll-mt-24">
            <h2>Angaben gemäß § 5 DDG</h2>
            <p>
              Christian Seidel
              <br />
              Am Hang 4<br />
              95152 Selbitz
              <br />
              Deutschland
            </p>

            <h2>Kontakt</h2>
            <p>
              E-Mail:&nbsp;
              <a
                className="text-[var(--accent)] hover:underline"
                href="mailto:christian.pressig@web.de"
              >
                christian.pressig@web.de
              </a>
            </p>

            <h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
            <p>
              Christian Seidel
              <br />
              Am Hang 4<br />
              95152 Selbitz
            </p>

            <h2>Projektinformationen</h2>
            <p>
              <strong>Cryptflow</strong> ist ein Projekt mit Login-Funktion und
              Datenspeicherung über Firebase (Google). Es dient überwiegend
              Lern- und Demozwecken. Eine durchgehende Verfügbarkeit, technische
              Fehlerfreiheit oder Eignung für geschäftliche Zwecke wird nicht
              zugesichert.
            </p>

            <h2>Haftung für Inhalte</h2>
            <p>
              Als Diensteanbieter bin ich für eigene Inhalte auf diesen Seiten
              nach den allgemeinen Gesetzen verantwortlich. Für von Nutzern
              eingestellte fremde Inhalte (z. B. Chat-Nachrichten) gilt die
              Haftungsprivilegierung nach § 7 des Digitale-Dienste-Gesetzes
              (DDG) in Verbindung mit Art. 6 der Verordnung (EU) 2022/2065
              (Digital Services Act, &bdquo;DSA&ldquo;): Eine Verantwortlichkeit besteht
              erst ab dem Zeitpunkt der Kenntnis einer konkreten
              Rechtsverletzung. Nach § 7 DDG i. V. m. Art. 8 DSA besteht keine
              allgemeine Verpflichtung, übermittelte oder gespeicherte
              Informationen zu überwachen oder aktiv nach Umständen zu
              forschen, die auf eine rechtswidrige Tätigkeit hinweisen. Für
              Ende-zu-Ende-verschlüsselte Nachrichteninhalte besteht für mich
              als Betreiber technisch ohnehin keine Möglichkeit der
              Kenntnisnahme. Verpflichtungen zur Entfernung oder Sperrung der
              Nutzung von Informationen nach den allgemeinen Gesetzen bleiben
              hiervon unberührt.
            </p>

            <h2>Haftung für Links</h2>
            <p>
              Diese Website enthält ggf. Links zu externen Websites Dritter, auf
              deren Inhalte ich keinen Einfluss habe. Deshalb kann ich für diese
              fremden Inhalte auch keine Gewähr übernehmen. Für die Inhalte der
              verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber
              verantwortlich.
            </p>

            <h2>Urheberrecht</h2>
            <p>
              Die durch den Seitenbetreiber erstellten Inhalte und Werke auf
              diesen Seiten unterliegen dem deutschen Urheberrecht. Beiträge
              Dritter sind als solche gekennzeichnet. Die Vervielfältigung,
              Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der
              Grenzen des Urheberrechts bedürfen der schriftlichen Zustimmung
              des jeweiligen Autors bzw. Erstellers.
            </p>

            <h2>Verbraucherstreitbeilegung</h2>
            <p>
              Ich bin nicht bereit und nicht verpflichtet, an
              Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle
              teilzunehmen (§ 36 VSBG).
            </p>
          </section>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/Login" className="btn-primary text-sm sm:text-base">
              Zur Startseite
            </Link>
            <Link
              href="/ImpressumundDatenschutz/PrivacyPolicy"
              className="btn-secondary text-sm sm:text-base"
            >
              Zur Datenschutzerklärung
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
