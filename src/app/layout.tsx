import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prospect Copilot",
  description:
    "Chat-based sales intelligence: prospect research, qualification, contacts, and outreach.",
};

/**
 * Root document shell shared by every route.
 * @param children the routed page content
 * @returns the html/body wrapper
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
