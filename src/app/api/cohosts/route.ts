import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PUBLIC_BASE_URL } from "@/lib/env";

export const runtime = "nodejs";

// Owner-only: co-host management. This route sits behind the proxy's owner gate
// (it is neither public nor a /api/cohost/ co-host route), so only the owner
// reaches it. Creating a CoHost row IS the invite: the person can then sign in
// with that Google address and land on their own /cohost page. No email is sent
// — the owner tells them to sign in.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Validate an IANA zone by asking Intl to format with it; it throws on garbage.
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  const coHosts = await prisma.coHost.findMany({
    orderBy: { createdAt: "asc" },
    // How many calendars this co-host has actually CONNECTED (has stored
    // credentials for). This is the setup signal the owner needs — a joint link
    // can only check a co-host's availability once they've connected at least
    // one. We expose the COUNT only, never the calendar addresses (privacy wall).
    include: {
      accounts: {
        where: { OR: [{ refreshToken: { not: null } }, { accessToken: { not: null } }] },
        select: { id: true },
      },
    },
  });
  return NextResponse.json({
    // The CANONICAL public sign-in URL — PUBLIC_BASE_URL (the real domain, e.g.
    // https://bookwithhunter.com), NOT the host this request arrived on and NOT
    // APP_BASE_URL (an internal/webhook host). A co-host must sign in on the
    // domain registered with Google OAuth; a .vercel.app alias is NOT registered,
    // so signing in there fails and dumps them on /book. Using the public base
    // keeps the invite correct no matter which URL the owner is viewing from.
    loginUrl: new URL("/login", PUBLIC_BASE_URL).toString(),
    coHosts: coHosts.map((c) => ({
      id: c.id,
      email: c.email,
      name: c.name,
      timezone: c.timezone,
      linkedin: c.linkedin,
      connectedCalendars: c.accounts.length,
    })),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { email?: string; name?: string; timezone?: string; linkedin?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const name = body.name?.trim();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }
  // Timezone is optional; fall back to the schema default when omitted.
  const timezone = body.timezone?.trim();
  if (timezone && !isValidTimeZone(timezone)) {
    return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
  }
  // LinkedIn is optional; if present it must be an http(s) URL.
  const linkedin = body.linkedin?.trim();
  if (linkedin && !isHttpUrl(linkedin)) {
    return NextResponse.json({ error: "invalid_linkedin" }, { status: 400 });
  }

  try {
    const coHost = await prisma.coHost.create({
      data: { email, name, ...(timezone ? { timezone } : {}), ...(linkedin ? { linkedin } : {}) },
    });
    return NextResponse.json(
      {
        coHost: {
          id: coHost.id,
          email: coHost.email,
          name: coHost.name,
          timezone: coHost.timezone,
          linkedin: coHost.linkedin,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    // Unique email — that address is already a co-host.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "already_cohost" }, { status: 409 });
    }
    throw err;
  }
}
