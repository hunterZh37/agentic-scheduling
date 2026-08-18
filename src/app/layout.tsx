import type { Metadata, Viewport } from "next";
import "./globals.css";
import { HOST } from "@/lib/booking/publicConfig";

const OWNER_NAME = HOST.name;
import { ThemeProvider, themeInitScript } from "@/components/theme/ThemeProvider";

// Real, specific metadata (owner name, what the site is, canonical base URL)
// rather than a bare generic title. Besides normal SEO, this matters for web
// reputation: content classifiers flagged this young domain as suspect partly
// because it presented no identity signals (see also public/robots.txt,
// public/.well-known/security.txt, and src/app/sitemap.ts).
export const metadata: Metadata = {
  metadataBase: new URL("https://bookwithhunter.com"),
  title: {
    default: `Book with ${OWNER_NAME}`,
    template: `%s · Book with ${OWNER_NAME}`,
  },
  description:
    `Booking page for ${OWNER_NAME}'s personal consulting practice: ${HOST.practice.fields}. ` +
    `See open times and book a meeting.`,
  openGraph: {
    siteName: `Book with ${OWNER_NAME}`,
    type: "website",
    url: "https://bookwithhunter.com",
  },
};

// Next injects a default viewport meta, but we set it explicitly to (a) keep
// pinch-zoom available (accessibility — no maximumScale/userScalable lockdown)
// and (b) have the mobile keyboard resize the visual viewport so the agent
// composer stays pinned and reachable instead of being covered.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-visual",
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F5F7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/* Enable entrance motion (Reveal) only when the visitor allows it, and
            only with JS. Runs before first paint, so reveals hide without a
            flash — and crawlers / no-JS get the fully-visible server HTML,
            never hidden text. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches){document.documentElement.classList.add('motion-ok')}}catch(e){}",
          }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
