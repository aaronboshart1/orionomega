import type { MetadataRoute } from 'next';

/**
 * Generates /robots.txt.
 *
 * OrionOmega is an internal dashboard — all crawlers are disallowed to prevent
 * accidental indexing of a privately deployed instance.
 */
export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:5000';

  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
