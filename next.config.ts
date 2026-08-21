import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Move the dev-tools "N" badge out of the sidebar's bottom-left corner.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
