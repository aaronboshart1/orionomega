import type { MetadataRoute } from 'next';

/**
 * Generates /sitemap.xml.
 *
 * OrionOmega is an internal dashboard with no public-facing pages, so the
 * sitemap only lists the root URL.  If public routes are added in the future,
 * expand this list or fetch URLs from a CMS/API.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:5000';

  return [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
  ];
}
