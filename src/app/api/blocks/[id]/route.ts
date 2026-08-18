import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isValidTimezone, parseIsoDate } from "@/lib/validation";

export const runtime = "nodejs";

interface BlockPatchBody {
  visible?: boolean;
  done?: boolean;
  title?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  recurrenceRule?: string | null;
}

// Update a PersonalBlock (Blocks pane). Accepts any subset of the editable
// fields: a lone `{ visible }` toggle, or a full edit (title / time / timezone /
// recurrence) from the block sheet. Only the provided fields are changed.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: BlockPatchBody;
  try {
    body = (await req.json()) as BlockPatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const data: Prisma.PersonalBlockUpdateInput = {};

  if (body.visible !== undefined) {
    if (typeof body.visible !== "boolean") {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    data.visible = body.visible;
  }

  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    data.done = body.done;
  }

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) {
      return NextResponse.json({ error: "invalid_input", message: "title cannot be empty." }, { status: 400 });
    }
    data.title = title;
  }

  // Times are edited together (both or neither): the range must stay valid.
  if (body.startTime !== undefined || body.endTime !== undefined) {
    const start = parseIsoDate(body.startTime);
    const end = parseIsoDate(body.endTime);
    if (!start || !end) {
      return NextResponse.json(
        { error: "invalid_range", message: "startTime and endTime (ISO 8601) must both be provided." },
        { status: 400 }
      );
    }
    if (end <= start) {
      return NextResponse.json({ error: "invalid_range", message: "endTime must be after startTime." }, { status: 400 });
    }
    data.startTime = start;
    data.endTime = end;
  }

  if (body.timezone !== undefined) {
    const timezone = body.timezone.trim();
    if (!isValidTimezone(timezone)) {
      return NextResponse.json({ error: "invalid_timezone", message: `Unknown IANA timezone: ${timezone}.` }, { status: 400 });
    }
    data.timezone = timezone;
  }

  if (body.recurrenceRule !== undefined) {
    data.recurrenceRule = body.recurrenceRule?.trim() || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "invalid_input", message: "No editable fields provided." }, { status: 400 });
  }

  try {
    const block = await prisma.personalBlock.update({ where: { id }, data });
    return NextResponse.json({ block });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}

// DELETE a PersonalBlock (private). Backs delete_personal_block.
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    await prisma.personalBlock.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}
