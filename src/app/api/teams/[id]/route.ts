import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Owner-only: rename a booking link (its display name / title). The slug (public
// URL) is deliberately not changed here — a live link should keep working.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "invalid_name" }, { status: 400 });

  try {
    const team = await prisma.team.update({ where: { id }, data: { name } });
    return NextResponse.json({ team: { id: team.id, name: team.name, slug: team.slug } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}

// Owner-only: delete a booking link (team). Cascades to its TeamMember rows
// (schema onDelete: Cascade). Co-hosts and their calendars are untouched — only
// the shared link goes away, and /book/<slug> stops resolving.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    await prisma.team.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}
