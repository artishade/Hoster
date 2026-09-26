import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { QueryProvider } from "@/components/query-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NexusHost — AI, MCP & API Cloud Platform",
  description:
    "High-performance cloud hosting platform for API Providers, MCP Servers, and AI Plugins with GPU acceleration, 1-click PostgreSQL & Redis, S3 mounts, real host telemetry, and free provider integrations.",
  openGraph: {
    title: "NexusHost — AI, MCP & API Cloud Platform",
    description: "Fully realistic cloud hosting control plane with live host telemetry and free provider pool.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#090a0f] text-zinc-100`}
      >
        <QueryProvider>{children}</QueryProvider>
        <Toaster />
      </body>
    </html>
  );
}
