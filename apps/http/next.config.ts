import type { NextConfig } from "next";

const config: NextConfig = {
  // The workspace packages ship TypeScript source.
  transpilePackages: ["@nexus-bot/core", "@nexus-bot/db", "@nexus-bot/discord"],
  poweredByHeader: false,
};

export default config;
