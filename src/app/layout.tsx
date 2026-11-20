import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geist = localFont({
  src: [
    { path: "../fonts/geist-latin-wght-normal.woff2", weight: "100 900", style: "normal" },
    { path: "../fonts/geist-latin-ext-wght-normal.woff2", weight: "100 900", style: "normal" },
  ],
  variable: "--font-geist",
  display: "swap",
});
const geistMono = localFont({
  src: "../fonts/geist-mono-latin-wght-normal.woff2",
  variable: "--font-geist-mono",
  display: "swap",
});

const serif = localFont({
  src: "../fonts/newsreader-latin-wght-normal.woff2",
  weight: "200 800",
  variable: "--font-serif-src",
  display: "swap",
});

export const metadata: Metadata = {
  title: "One Portal Data",
  description: "One login for production, exploration and head office data.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};
export const viewport: Viewport = { themeColor: "#c2410c", width: "device-width", initialScale: 1, viewportFit: "cover" };

// Sets theme before first paint so there is no flash.
const PRE = `try{var d=document.documentElement,t=localStorage.getItem('exp_theme');if(!t)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';d.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={`${geist.variable} ${geistMono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: PRE }} /></head>
      <body>{children}</body>
    </html>
  );
}
