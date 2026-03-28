import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { ToastContainer } from '@/components/ToastContainer';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'OmegaClaw',
  description: 'AI Agent Orchestration Dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark overflow-hidden h-dvh">
      <body className={`${inter.className} h-dvh bg-[var(--background)] text-[var(--foreground)] antialiased overflow-hidden`}>
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
