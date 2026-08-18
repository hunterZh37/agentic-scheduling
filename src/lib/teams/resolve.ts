import { prisma } from "@/lib/db";

export interface ResolvedTeam {
  id: string;
  slug: string;
  name: string;
  eventTitle: string;
  videoLink: string | null;
  durationOptionsMinutes: number[];
  /// Co-host ids on the team (owner excluded) — for scoping free/busy.
  coHostIds: string[];
  /// Co-host contact info — for putting every host on the joint invite and
  /// naming the team on the public page. Never exposed to the availability API
  /// response, only used server-side.
  coHosts: { id: string; name: string; email: string; linkedin: string | null }[];
}

/// A human "meeting with" label from a list of full names, using first names:
/// ["Ben Brooks", "Hunter Zhang"] -> "Ben & Hunter". So the confirmation email
/// names the PEOPLE, not the team's internal name (which may just be "Team").
export function firstNamesLabel(fullNames: string[]): string {
  const firsts = fullNames
    .map((n) => n.trim().split(/\s+/)[0] || n.trim())
    .filter(Boolean);
  if (firsts.length <= 1) return firsts[0] ?? "";
  if (firsts.length === 2) return `${firsts[0]} & ${firsts[1]}`;
  return `${firsts.slice(0, -1).join(", ")} & ${firsts[firsts.length - 1]}`;
}

/// Resolve a public team slug to the data the joint booking flow needs, or null
/// if no such team. Shared by the public availability API and the booking write
/// so both agree on exactly which co-hosts a slug covers.
export async function teamForSlug(slug: string): Promise<ResolvedTeam | null> {
  const team = await prisma.team.findUnique({
    where: { slug },
    include: {
      members: {
        include: { coHost: { select: { id: true, name: true, email: true, linkedin: true } } },
      },
    },
  });
  if (!team) return null;

  const coHosts = team.members
    .map((m) => m.coHost)
    .filter((c): c is { id: string; name: string; email: string; linkedin: string | null } => c !== null);

  return {
    id: team.id,
    slug: team.slug,
    name: team.name,
    eventTitle: team.eventTitle,
    videoLink: team.videoLink,
    durationOptionsMinutes: team.durationOptionsMinutes,
    coHostIds: coHosts.map((c) => c.id),
    coHosts,
  };
}
