import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Prevent MIME-type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Deny framing — prevents clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // Limit referrer info on cross-origin navigations
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restrict powerful browser APIs
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );

  // Content Security Policy.
  // - script-src/style-src need unsafe-inline for Next.js hydration and Tailwind.
  // - connect-src allows ws:/wss: for the gateway WebSocket (same origin).
  // - frame-ancestors replaces X-Frame-Options for modern browsers.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', csp);

  return response;
}

export const config = {
  matcher: [
    // Run on all routes except static assets and Next.js internals.
    '/((?!_next/static|_next/image|favicon\\.ico|sitemap\\.xml|robots\\.txt).*)',
  ],
};
