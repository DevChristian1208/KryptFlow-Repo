import type { NextConfig } from "next";

// Content-Security-Policy wird NICHT hier gesetzt, sondern per-Request in
// src/middleware.ts (mit einer frischen Nonce für script-src) — Next.js
// injiziert selbst mehrere Inline-<script>-Tags pro Seite (RSC-Hydration-
// Payload), die sich nicht mit einem hier statisch festgelegten Hash
// abdecken lassen. Die übrigen Security-Header sind seitenunabhängig und
// bleiben deshalb hier.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
