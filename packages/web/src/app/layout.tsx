import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import 'highlight.js/styles/github-dark.css';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

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
      <body className={`${inter.className} h-full min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased`}>
        {children}
      </body>
    </html>
  );
}
