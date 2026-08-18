import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Owner-only: booking-link ("team") management. Behind the proxy owner gate
// (neither public nor a /api/cohost/ route). A team is the owner plus one or
// more co-hosts; its slug is the public booking URL /book/<slug>, which offers
// only times EVERY member is free.

// URL-safe slug: lowercase letters/digits in hyphen-separated groups.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function serialize(
  team: {
    id: string;
    slug: string;
    name: string;
    eventTitle: string;
    videoLink: string | null;
    durationOptionsMinutes: number[];
    members: { coHostId: string | null; coHost: { name: string; email: string } | null }[];
  }
) {
  return {
    id: team.id,
    slug: team.slug,
    name: team.name,
    eventTitle: team.eventTitle,
    videoLink: team.videoLink,
    durationOptionsMinutes: team.durationOptionsMinutes,
    bookingPath: `/book/${team.slug}`,
    // The owner (coHostId null) plus each co-host, as display rows.
    members: team.members.map((m) =>
      m.coHost
        ? { kind: "cohost" as const, name: m.coHost.name, email: m.coHost.email }
        : { kind: "owner" as const }
    ),
  };
}

export async function GET(): Promise<NextResponse> {
  const teams = await prisma.team.findMany({
    orderBy: { createdAt: "asc" },
    include: { members: { include: { coHost: { select: { name: true, email: true } } } } },
  });
  return NextResponse.json({ teams: teams.map(serialize) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    name?: string;
    slug?: string;
    coHostIds?: unknown;
    eventTitle?: string;
    videoLink?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = body.name?.trim();
  const slug = body.slug?.trim().toLowerCase();
  if (!name) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }
  // Reserved: /book/<slug> must not collide with the owner's own booking page or
  // its query modes. Keep this list in sync with real /book sub-paths.
  if (["preview", "demo", "manage"].includes(slug)) {
    return NextResponse.json({ error: "reserved_slug" }, { status: 409 });
  }

  const coHostIds = Array.isArray(body.coHostIds)
    ? [...new Set(body.coHostIds.filter((x): x is string => typeof x === "string"))]
    : [];
  if (coHostIds.length === 0) {
    // A team with no co-hosts is just the owner's own page — pointless as a joint
    // link. Require at least one co-host.
    return NextResponse.json({ error: "no_cohosts" }, { status: 400 });
  }

  // Every listed co-host must exist, or the team would advertise a member whose
  // calendar can never be checked.
  const found = await prisma.coHost.count({ where: { id: { in: coHostIds } } });
  if (found !== coHostIds.length) {
    return NextResponse.json({ error: "unknown_cohost" }, { status: 400 });
  }

  const eventTitle = body.eventTitle?.trim();
  const videoLink = body.videoLink?.trim();

  try {
    const team = await prisma.team.create({
      data: {
        slug,
        name,
        ...(eventTitle ? { eventTitle } : {}),
        ...(videoLink ? { videoLink } : {}),
        members: {
          // The owner is always a member (coHostId null), plus each co-host.
          create: [{ coHostId: null }, ...coHostIds.map((id) => ({ coHostId: id }))],
        },
      },
      include: { members: { include: { coHost: { select: { name: true, email: true } } } } },
    });
    return NextResponse.json({ team: serialize(team) }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    throw err;
  }
}
