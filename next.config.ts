import type { NextConfig } from "next";

// NEXT_PUBLIC_BASE_PATH (build time): serve under a sub-path, e.g. /sre behind a reverse proxy. Empty locally.
const nextConfig: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  output: 'standalone',
  cacheComponents: true,
  partialPrefetching: true,
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
