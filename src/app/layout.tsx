import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { createLogger } from '@/utils/logger';
import AppWrapper from "@/frontend/components/AppWrapper";

const log = createLogger('app/layout');

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "FLUJO — Local AI Operations",
    template: "%s · FLUJO",
  },
  description: "Design, connect, and run private AI systems from one local operations studio.",
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F5F7FF' },
    { media: '(prefers-color-scheme: dark)', color: '#070912' },
  ],
};


export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  log.debug('Rendering RootLayout');
  return ( 
    <html
      lang="en"
      className="modern-theme"
      data-visual-style="modern"
      style={{ colorScheme: 'light' }}
      suppressHydrationWarning
    >
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AppWrapper>
          {children}
        </AppWrapper>
      </body>
    </html>
  );
}
