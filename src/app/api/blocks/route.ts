import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isValidTimezone, parseIsoDate } from "@/lib/validation";

export const runtime = "nodejs";

// PersonalBlock CRUD (private). Backs the blocks manager UI and the private
// agent's create/list/delete_personal_block tools.

export async function GET(): Promise<NextResponse> {
  const blocks = await prisma.personalBlock.findMany({
    orderBy: { startTime: "asc" },
  });
  return NextResponse.json({ blocks });
}

interface BlockBody {
  title?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  recurrenceRule?: string | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: BlockBody;
  try {
    body = (await req.json()) as BlockBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const title = body.title?.trim();
  const start = parseIsoDate(body.startTime);
  const end = parseIsoDate(body.endTime);
  const timezone = body.timezone?.trim() || "America/Los_Angeles";

  if (!title || !start || !end) {
    return NextResponse.json(
      { error: "missing_params", message: "title, startTime, endTime (ISO 8601) are required." },
      { status: 400 }
    );
  }
  if (end <= start) {
    return NextResponse.json(
      { error: "invalid_range", message: "endTime must be after startTime." },
      { status: 400 }
    );
  }
  if (!isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: "invalid_timezone", message: `Unknown IANA timezone: ${timezone}.` },
      { status: 400 }
    );
  }

  const block = await prisma.personalBlock.create({
    data: {
      title,
      startTime: start,
      endTime: end,
      timezone,
      recurrenceRule: body.recurrenceRule?.trim() || null,
    },
  });
  return NextResponse.json({ block }, { status: 201 });
}
