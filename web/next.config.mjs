import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Für das Docker-/Railway-Deployment: minimaler Standalone-Server unter
  // .next/standalone (Layout gespiegelt am Workspace-Root). Nur im Docker-
  // Build aktiv (web/Dockerfile setzt NEXT_STANDALONE=1) — auf Windows
  // scheitert das Tracing sonst an fehlenden Symlink-Rechten (EPERM).
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  outputFileTracingRoot: workspaceRoot,
  // Wallet-Adapter / web3.js sind rein clientseitig — nichts Besonderes nötig,
  // aber wir pinnen ein sauberes Verhalten für optionale Node-Module.
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      os: false,
      path: false,
    };
    config.externals = [...(config.externals ?? []), "pino-pretty"];
    return config;
  },
};

export default nextConfig;
