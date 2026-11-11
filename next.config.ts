import type { NextConfig } from "next";

/** Hosts from APP_TRUSTED_ORIGINS, so `next dev` accepts LAN workstations too. */
function devOrigins(): string[] {
  return (process.env.APP_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => {
      try {
        return new URL(o.trim()).hostname;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

const nextConfig: NextConfig = {
  // Optional separate build folder (e.g. GALIA_DIST_DIR=.next-qa) so a new version can be
  // built and checked without touching the `.next` folder of a server that is still running.
  distDir: process.env.GALIA_DIST_DIR || ".next",
  experimental: {
    agentFeedback: true,
  },
  // Request-time rendering only: every page reads the session and must never be
  // served from a prerendered/cached shell, and the scan page must not be kept
  // mounted in the background (Activity) with its listeners torn down.
  cacheComponents: false,
  poweredByHeader: false,
  allowedDevOrigins: devOrigins(),
  serverExternalPackages: ["@node-rs/argon2"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
