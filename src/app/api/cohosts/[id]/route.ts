import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Owner-only: edit a co-host's fields (email, name, timezone, LinkedIn). Email is
// the login identity (the Google address they sign in with), so changing it
// changes who can sign in as this co-host — allowed here, validated + unique.
// Send linkedin:"" to clear it.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: { email?: string; name?: string; timezone?: string; linkedin?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const data: { email?: string; name?: string; timezone?: string; linkedin?: string | null } = {};
  if (body.email !== undefined) {
    const email = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    data.email = email;
  }
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    data.name = name;
  }
  if (body.timezone !== undefined) {
    const tz = body.timezone.trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
    }
    data.timezone = tz;
  }
  if (body.linkedin !== undefined) {
    const linkedin = body.linkedin.trim();
    if (linkedin && !isHttpUrl(linkedin)) {
      return NextResponse.json({ error: "invalid_linkedin" }, { status: 400 });
    }
    data.linkedin = linkedin || null; // "" clears it
  }

  try {
    const c = await prisma.coHost.update({ where: { id }, data });
    return NextResponse.json({
      coHost: { id: c.id, email: c.email, name: c.name, timezone: c.timezone, linkedin: c.linkedin },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2025") return NextResponse.json({ error: "not_found" }, { status: 404 });
      // Unique email — that address is already another co-host.
      if (err.code === "P2002") return NextResponse.json({ error: "already_cohost" }, { status: 409 });
    }
    throw err;
  }
}

// Owner-only: remove a co-host. Cascades (schema onDelete: Cascade) to their
// connected calendars, reserved blocks and team memberships — a full revoke.
// Their session stops resolving immediately (currentCoHost returns null), so
// they fall back to the sign-in screen on their next request.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    await prisma.coHost.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}
