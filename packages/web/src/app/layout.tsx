import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { ToastContainer } from '@/components/ToastContainer';
import './globals.css';

const inter = localFont({
  src: './fonts/InterVariable.woff2',
  display: 'swap',
});

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
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-[var(--background)] text-[var(--foreground)] antialiased overflow-hidden`}>
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
