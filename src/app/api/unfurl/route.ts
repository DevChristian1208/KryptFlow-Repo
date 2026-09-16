import { NextRequest, NextResponse } from "next/server";
import dns from "node:dns/promises";
import net from "node:net";

// Läuft bewusst NICHT über die Nachrichteninhalte selbst (auch wenn dank der
// Gäste-Channel-Umstellung nicht mehr ausnahmslos Ende-zu-Ende-verschlüsselt)
// — der Client extrahiert die URL clientseitig aus dem Nachrichtentext und
// fragt hier nur die URL selbst an, nie den restlichen Nachrichteninhalt.

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 169.254.0.0/16 (Link-Local) — deckt u.a. 169.254.169.254 ab, den
    // Cloud-Metadata-Endpunkt bei AWS/GCP/Azure, ein beliebtes SSRF-Ziel.
    if (a === 169 && b === 254) return true;
    // 100.64.0.0/10 (Carrier-Grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (type === 6) {
    const h = ip.toLowerCase();
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
      return true; // fe80::/10, Link-Local
    }
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7, Unique Local
    const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) return isPrivateIp(v4Mapped[1]);
    return false;
  }
  return true; // keine gültige IP -> vorsichtshalber ablehnen
}

// Prüft nicht nur den Hostnamen selbst, sondern löst ihn per DNS auf und
// prüft JEDE zurückgegebene Adresse — verhindert sowohl DNS-Rebinding (ein
// öffentlicher Domainname, der auf eine interne IP zeigt) als auch simple
// String-Umgehungen des Hostnamen-Checks.
async function isHostnameSafe(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return false;
  if (net.isIP(h)) return !isPrivateIp(h);
  try {
    const results = await dns.lookup(h, { all: true, verbatim: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateIp(r.address));
  } catch {
    return false;
  }
}

function extractMeta(html: string) {
  const get = (re: RegExp) => html.match(re)?.[1]?.trim();
  const byProperty = (name: string) =>
    get(
      new RegExp(
        `<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']*)["']`,
        "i"
      )
    ) ||
    get(
      new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${name}["']`,
        "i"
      )
    );
  const byName = (name: string) =>
    get(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    get(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, "i"));

  const title = byProperty("og:title") || get(/<title[^>]*>([^<]*)<\/title>/i);
  const description = byProperty("og:description") || byName("description");
  const image = byProperty("og:image");
  const siteName = byProperty("og:site_name");

  return { title, description, image, siteName };
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

// YouTube-Seiten sind fürs Regex-Scraping unten schlecht geeignet: sehr
// große, skriptlastige HTML-Antworten, teils zusätzlich eine Cookie-
// Consent-Zwischenseite statt der echten Videoseite für Anfragen ohne
// Browser-Cookies — dadurch blieben Thumbnails bisher leer. Die offizielle,
// öffentliche oEmbed-API liefert Titel/Thumbnail/Autor direkt und robust,
// ganz ohne HTML-Parsing.
async function fetchYoutubeOembed(target: URL, signal: AbortSignal) {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(target.toString())}&format=json`,
    { signal, headers: { Accept: "application/json" } }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  };
  if (!data.thumbnail_url) return null;
  return {
    title: data.title?.slice(0, 200),
    description: data.author_name ? `von ${data.author_name}` : undefined,
    image: data.thumbnail_url,
    siteName: "YouTube",
  };
}

function decodeEntities(s?: string): string | undefined {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

export async function GET(req: NextRequest) {
  const urlParam = req.nextUrl.searchParams.get("url");
  if (!urlParam) {
    return NextResponse.json({ error: "missing url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(urlParam);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "unsupported protocol" }, { status: 400 });
  }
  if (!(await isHostnameSafe(target.hostname))) {
    return NextResponse.json({ error: "forbidden host" }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  if (YOUTUBE_HOSTS.has(target.hostname.toLowerCase())) {
    try {
      const data = await fetchYoutubeOembed(target, controller.signal);
      clearTimeout(timeout);
      if (data) return NextResponse.json(data);
      return NextResponse.json({ error: "not found" }, { status: 200 });
    } catch {
      clearTimeout(timeout);
      return NextResponse.json({ error: "fetch failed" }, { status: 200 });
    }
  }

  try {
    // redirect: "manual" statt "follow" — jeder Redirect-Sprung wird erneut
    // gegen isHostnameSafe geprüft, sonst könnte eine harmlos aussehende
    // öffentliche URL per 3xx auf eine interne Adresse umleiten und der
    // Hostnamen-Check vom Erstaufruf würde nie greifen.
    let current = target;
    let res: Response;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) {
        clearTimeout(timeout);
        return NextResponse.json({ error: "too many redirects" }, { status: 200 });
      }
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        clearTimeout(timeout);
        return NextResponse.json({ error: "unsupported protocol" }, { status: 400 });
      }
      if (!(await isHostnameSafe(current.hostname))) {
        clearTimeout(timeout);
        return NextResponse.json({ error: "forbidden host" }, { status: 400 });
      }
      res = await fetch(current.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CryptflowLinkPreview/1.0)",
          Accept: "text/html",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break;
        try {
          current = new URL(location, current);
        } catch {
          break;
        }
        continue;
      }
      break;
    }
    clearTimeout(timeout);

    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("text/html")) {
      return NextResponse.json({ error: "not html" }, { status: 200 });
    }

    const reader = res.body?.getReader();
    let html = "";
    let bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      while (bytes < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
    }

    const meta = extractMeta(html);
    let image = meta.image;
    if (image) {
      try {
        image = new URL(image, target).toString();
      } catch {
        image = undefined;
      }
    }

    return NextResponse.json({
      title: decodeEntities(meta.title)?.slice(0, 200),
      description: decodeEntities(meta.description)?.slice(0, 300),
      image,
      siteName: decodeEntities(meta.siteName)?.slice(0, 100),
    });
  } catch {
    clearTimeout(timeout);
    return NextResponse.json({ error: "fetch failed" }, { status: 200 });
  }
}
