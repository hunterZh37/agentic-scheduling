import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Update an account's friendly name or visibility (Calendars manager). Never
// touches tokens, provider, or email — those are identity.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: {
    displayName?: string | null;
    visible?: boolean;
    checkForConflicts?: boolean;
    isDestination?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.displayName !== undefined && typeof body.displayName !== "string" && body.displayName !== null) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const data: Prisma.AccountUpdateInput = {};
  if (body.displayName !== undefined) {
    const trimmed = body.displayName?.trim();
    data.displayName = trimmed ? trimmed : null; // empty -> revert to email
  }
  if (typeof body.visible === "boolean") data.visible = body.visible;
  // Whether this account participates in free/busy conflict checks. Turning it
  // off excludes the account from fanOutBusy — useful for a calendar that can't
  // be read (e.g. a Google account without Calendar provisioned), which would
  // otherwise fail the fail-closed availability check and block every booking.
  if (typeof body.checkForConflicts === "boolean") data.checkForConflicts = body.checkForConflicts;

  // Moving the destination is its own operation: exactly one account may hold
  // it, and it decides where every future booking is written. Done in a
  // transaction so a failure can never leave zero destinations (bookings would
  // fail with no_destination) or two (findFirst would pick arbitrarily).
  // Owner routes operate on owner accounts only (coHostId=null). A co-host's
  // account is theirs — the owner must not rename, retarget, or otherwise touch
  // it. Absent (or co-host-owned) ids read as 404, same as a missing row.
  const owned = await prisma.account.findFirst({ where: { id, coHostId: null } });
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (body.isDestination === true) {
    const target = owned;
    // A calendar we cannot write to would accept bookings and then fail on the
    // event insert, after the visitor has been told they are booked.
    if (!target.refreshToken && !target.accessToken) {
      return NextResponse.json(
        {
          error: "not_connected",
          message: "That calendar has no stored credentials — reconnect it before making it the destination.",
        },
        { status: 409 }
      );
    }
    const [, updated] = await prisma.$transaction([
      prisma.account.updateMany({
        where: { isDestination: true, NOT: { id } },
        data: { isDestination: false },
      }),
      prisma.account.update({ where: { id }, data: { ...data, isDestination: true } }),
    ]);
    return NextResponse.json({
      account: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        visible: updated.visible,
        isDestination: true,
      },
    });
  }
  if (body.isDestination === false) {
    // Clearing it would leave nowhere to write. Move it elsewhere instead.
    return NextResponse.json(
      {
        error: "invalid_input",
        message: "Set isDestination:true on another account to move it; it cannot simply be cleared.",
      },
      { status: 400 }
    );
  }

  try {
    const a = await prisma.account.update({ where: { id }, data });
    return NextResponse.json({
      account: { id: a.id, email: a.email, displayName: a.displayName, visible: a.visible },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}

// Remove (disconnect) a calendar account — deletes the row and its stored OAuth
// tokens. Refuses the destination/booking account (it owns bookings via an FK and
// is where new bookings are written), so removing it is blocked with a 409.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  // Owner accounts only — a co-host's account can't be disconnected from here
  // (co-host privacy wall). A co-host-owned id reads as 404.
  const account = await prisma.account.findFirst({ where: { id, coHostId: null } });
  if (!account) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (account.isDestination) {
    return NextResponse.json(
      { error: "is_destination", message: "This is your booking destination account and can't be removed." },
      { status: 409 }
    );
  }
  await prisma.account.delete({ where: { id } });
  return NextResponse.json({ deleted: id });
}
