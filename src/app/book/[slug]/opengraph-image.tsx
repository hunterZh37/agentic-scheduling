import { renderTeamOgImage, OG_SIZE } from "@/lib/og/teamCard";

// Team-specific Open Graph card. Nodejs runtime because it reads the team from
// the DB. Overrides the app-wide static OG image for /book/<slug>.
export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Shared booking page";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return renderTeamOgImage(slug);
}
