import type { NextConfig } from "next";

// Baseline hardening headers applied to every response. These are trust signals
// automated site scanners (Mozilla Observatory, Safe Browsing tooling) check,
// and are safe with the App Router — no CSP `script-src`/`style-src` here, so
// Next's inline hydration scripts and CSS-module styles are unaffected. HSTS is
// already added by Vercel at the edge.
const securityHeaders = [
  // Block MIME-type sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // No embedding in frames (clickjacking). `frame-ancestors 'none'` below is the
  // modern equivalent; both are sent for older-agent coverage. Neither restricts
  // resource loading, so the app is unaffected.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // Don't leak full referrer URLs cross-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deny powerful browser features this app never uses.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
