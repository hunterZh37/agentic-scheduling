import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseBirthdayInput, sortBirthdaysUpcoming } from "@/lib/birthdays/birthdays";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

export const runtime = "nodejs";

// Birthday CRUD (private — not on the public allowlist, so the proxy 401s
// unauthenticated callers). A birthday is a recurring calendar date: month/day
// plus an optional birth year for age.

export async function GET(): Promise<NextResponse> {
  const rows = await prisma.birthday.findMany();
  const birthdays = sortBirthdaysUpcoming(rows, new Date(), OWNER_TIMEZONE);
  return NextResponse.json({ birthdays });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseBirthdayInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { name, month, day, year } = parsed.value;
  const birthday = await prisma.birthday.create({
    data: { name, month, day, year: year ?? null },
  });
  return NextResponse.json({ birthday }, { status: 201 });
}
