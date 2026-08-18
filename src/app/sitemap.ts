import type { MetadataRoute } from "next";

// Public pages only — the owner dashboard is login-gated and excluded.
// A sitemap (with robots.txt and security.txt) gives web classifiers and
// reputation reviewers a legible picture of the site, which matters for a
// young domain that filters would otherwise treat as suspect.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://bookwithhunter.com";
  return [
    { url: `${base}/book`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/assistant`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
