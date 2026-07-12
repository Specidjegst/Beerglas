import type { Metadata, Viewport } from "next";
import { Alfa_Slab_One, JetBrains_Mono, Outfit } from "next/font/google";
import WalletProviders from "@/components/WalletProviders";
import "./globals.css";

const slab = Alfa_Slab_One({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-slab",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ZAPF ROYALE — PvP Bierzapfen auf Solana",
  description:
    "PvP-Skill-Game auf Solana devnet: Zapfe exakt bis zur Ziel-Marke. Wer am nächsten dran ist, gewinnt den Pot.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  userScalable: false,
  themeColor: "#100B07",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className={`${slab.variable} ${outfit.variable} ${mono.variable}`}>
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
