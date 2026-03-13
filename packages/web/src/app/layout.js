import { Inter } from 'next/font/google';
import './globals.css';
const inter = Inter({ subsets: ['latin'] });
export const metadata = {
    title: 'OrionOmega',
    description: 'AI Agent Orchestration Dashboard',
};
export default function RootLayout({ children, }) {
    return (<html lang="en" className="dark">
      <body className={`${inter.className} h-full min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased`}>
        {children}
      </body>
    </html>);
}
//# sourceMappingURL=layout.js.map