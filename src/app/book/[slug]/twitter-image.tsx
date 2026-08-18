import { renderTeamOgImage, OG_SIZE } from "@/lib/og/teamCard";

// Same team card for Twitter/X clients that prefer twitter:image.
export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Shared booking page";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return renderTeamOgImage(slug);
}
