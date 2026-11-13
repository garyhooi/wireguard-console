import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const exportMode = process.env.NEXT_OUTPUT === "export";
const standaloneMode = process.env.NEXT_OUTPUT === "standalone";

const nextConfig: NextConfig = {
  output: exportMode ? "export" : standaloneMode ? "standalone" : undefined,
  turbopack: { root: path.resolve(".") },
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  images: {
    formats: ["image/avif", "image/webp"],
    // Static export has no Next.js image optimizer at runtime.
    unoptimized: exportMode,
  },
};

// Static export has no server. Cloudflare Pages applies the same security
// rules at the edge from public/_headers.
if (!exportMode) {
  nextConfig.headers = async () => [
    {
      source: "/:path*",
      headers: securityHeaders,
    },
    {
      source: "/screens/:path*",
      headers: [
        { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
      ],
    },
  ];
}

export default nextConfig;