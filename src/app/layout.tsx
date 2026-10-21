import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./living-watershed.css";
import { createLogger } from '@/utils/logger';
import AppWrapper from "@/frontend/components/AppWrapper";
import { connection } from 'next/server';
import { headers } from 'next/headers';

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


export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await connection();
  // UI hint only; all identity and authority stays at the controller boundary.
  const controllerAccount = (await headers()).get('x-flujo-controller-account') === '1';
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
        <AppWrapper phoneHost={process.env.FLUJO_AVATAR_PHONE_HOST === '1'} controllerAccount={controllerAccount}>
          {children}
        </AppWrapper>
      </body>
    </html>
  );
}
