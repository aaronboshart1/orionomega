import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  // Resolved against NEXT_PUBLIC_APP_URL for absolute OG/canonical URLs.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:5000'),
  title: {
    // Pages export: export const metadata = { title: 'My Page' }
    // → renders as "My Page | OrionOmega"
    template: '%s | OrionOmega',
    default: 'OrionOmega',
  },
  description: 'AI Agent Orchestration Dashboard — manage and monitor AI agents in real-time.',
  openGraph: {
    type: 'website',
    siteName: 'OrionOmega',
    title: 'OrionOmega',
    description: 'AI Agent Orchestration Dashboard',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OrionOmega',
    description: 'AI Agent Orchestration Dashboard',
  },
  // Internal dashboard — prevent search engine indexing.
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="font-[family-name:var(--font-inter)] bg-[var(--background)] text-[var(--foreground)] antialiased">
        {/* Skip-to-content link — invisible until focused via keyboard */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:border focus:border-zinc-600 focus:bg-zinc-800 focus:px-4 focus:py-2 focus:text-sm focus:text-zinc-100"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
