import type { Metadata } from "next";
import type { Viewport } from "next";
import { Cinzel, Space_Mono } from "next/font/google";
import localFont from "next/font/local";
import AdminSidebarShell from "@/components/layout/AdminSidebarShell";
import "./globals.css";

const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  weight: ["400", "700", "900"],
  display: "swap",
});

// Self-hosted rather than next/font/google: Vercel builds failed resolving
// Nunito's Google font files under Turbopack ("Can't resolve
// '@vercel/turbopack-next/internal/font/google/font' … next/font/google
// queries have exactly one entry") even though the same code built fine
// locally — bundling the file removes the build-time Google Fonts fetch.
// Nunito is a variable font, so this one latin-subset file (fonts.gstatic.com
// v32, OFL-licensed — see fonts/Nunito-OFL.txt) covers every weight; the
// "300 700" range matches the weights the Google config used to load.
const nunito = localFont({
  src: "./fonts/Nunito-latin-variable.woff2",
  variable: "--font-nunito",
  weight: "300 700",
  display: "swap",
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cleopatra Ink Studio",
  description: "AI-Powered Tattoo Design Platform",
};

export const viewport: Viewport = {
  themeColor: "#0D0D0D",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${nunito.variable} ${spaceMono.variable} h-full`}
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-ink">
        <AdminSidebarShell>{children}</AdminSidebarShell>
      </body>
    </html>
  );
}
