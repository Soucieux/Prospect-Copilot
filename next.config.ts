import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Move the dev-tools "N" badge out of the sidebar's bottom-left corner.
  devIndicators: { position: "bottom-right" },
  // `next dev` writes AGENTS.md and CLAUDE.md into the project whenever it
  // detects an AI coding agent. Its Next.js 16 note lives in the README instead.
  agentRules: false,
};

export default nextConfig;
