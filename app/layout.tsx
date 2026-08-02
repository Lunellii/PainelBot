import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Nerdzone Bot Manager",
  description: "Central para gerenciar contas e automações de Minecraft.",
  openGraph: { title: "Nerdzone Bot Manager", description: "15 contas. Um só painel.", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Nerdzone Bot Manager", description: "15 contas. Um só painel.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
