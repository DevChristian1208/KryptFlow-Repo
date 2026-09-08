import { NextRequest, NextResponse } from "next/server";

// Läuft bewusst NICHT über die Nachrichteninhalte selbst (Ende-zu-Ende-
// verschlüsselt, der Server sieht sie nie) — der Client extrahiert die URL
// erst NACH dem Entschlüsseln und fragt dann nur die URL selbst hier an.

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || h === "0.0.0.0" || h === "::1") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
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
  if (isPrivateHostname(target.hostname)) {
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
    const res = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CryptflowLinkPreview/1.0)",
        Accept: "text/html",
      },
    });
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
