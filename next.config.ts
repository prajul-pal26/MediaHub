import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: { ignoreBuildErrors: true },
  // Load Chromium driver from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["playwright-core"],
};

export default nextConfig;
