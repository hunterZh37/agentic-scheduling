import { NextRequest, NextResponse } from "next/server";
import type { Account } from "@prisma/client";
import { prisma } from "@/lib/db";
import { updateDestinationEvent, deleteDestinationEvent } from "@/lib/calendar/write";
import { parseIsoDate } from "@/lib/validation";

export const runtime = "nodejs";

// Edit / delete a real calendar event on the account it lives on. `id` is the
// provider-side event id; the body carries `accountEmail` so we can resolve the
// owning account (and its provider + tokens). Only events the owner organizes are
// editable — the UI gates this, and the provider is the final authority (a
// 403 from Google/Microsoft surfaces as an error here).

interface EventPatchBody {
  accountEmail?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  description?: string;
  notify?: boolean;
}

// Resolve the owning account, or a ready-to-return error response.
async function resolveAccount(email: string | undefined): Promise<NextResponse | Account> {
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "missing_account", message: "accountEmail is required." }, { status: 400 });
  }
  const account = await prisma.account.findFirst({ where: { email } });
  if (!account) {
    return NextResponse.json({ error: "unknown_account", message: `No connected account for ${email}.` }, { status: 404 });
  }
  if (!account.refreshToken && !account.accessToken) {
    return NextResponse.json(
      { error: "account_not_connected", message: `${email} is not connected. Reconnect it to edit its events.` },
      { status: 503 }
    );
  }
  return account;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: EventPatchBody;
  try {
    body = (await req.json()) as EventPatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const account = await resolveAccount(body.accountEmail);
  if (account instanceof NextResponse) return account;

  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: "invalid_input", message: "title cannot be empty." }, { status: 400 });
  }
  const start = parseIsoDate(body.startTime);
  const end = parseIsoDate(body.endTime);
  if (!start || !end) {
    return NextResponse.json({ error: "invalid_range", message: "startTime and endTime (ISO 8601) are required." }, { status: 400 });
  }
  if (end <= start) {
    return NextResponse.json({ error: "invalid_range", message: "endTime must be after startTime." }, { status: 400 });
  }

  try {
    await updateDestinationEvent(
      account,
      id,
      {
        title,
        start,
        end,
        // location/description are only forwarded when the client included them
        // (i.e. the user edited that field). Omitting a key leaves the provider
        // value untouched; sending "" deliberately clears it.
        ...(body.location !== undefined ? { location: body.location.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description.trim() } : {}),
      },
      { notify: body.notify === true }
    );
    return NextResponse.json({ ok: true, start: start.toISOString(), end: end.toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "event_update_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: { accountEmail?: string; notify?: boolean };
  try {
    body = (await req.json()) as { accountEmail?: string; notify?: boolean };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const account = await resolveAccount(body.accountEmail);
  if (account instanceof NextResponse) return account;

  try {
    await deleteDestinationEvent(account, id, { notify: body.notify === true, throwOnError: true });
    return NextResponse.json({ ok: true, deleted: id });
  } catch (err) {
    return NextResponse.json(
      { error: "event_delete_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
