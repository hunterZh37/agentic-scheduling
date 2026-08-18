import { NextRequest, NextResponse } from "next/server";
import { AuthMethod, Provider } from "@prisma/client";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Add a calendar account to manage. Creates the config row (no tokens); the
// caller then runs OAuth consent via connectUrl to authorize it. Idempotent —
// re-posting the same email leaves any existing tokens untouched. Behind the
// auth gate (private API), so only the owner can reach it.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { email?: string; provider?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (body.provider !== Provider.google && body.provider !== Provider.microsoft) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }
  const provider = body.provider;

  const account = await prisma.account.upsert({
    where: { email },
    // Keep tokens; only (re)assert config for an existing row.
    update: { provider, authMethod: AuthMethod.oauth },
    create: { email, provider, authMethod: AuthMethod.oauth, checkForConflicts: true },
  });

  return NextResponse.json(
    {
      account: {
        id: account.id,
        email: account.email,
        provider: account.provider,
        connected: Boolean(account.refreshToken || account.accessToken),
        connectUrl: `/api/oauth/${account.provider}/start`,
      },
    },
    { status: 201 }
  );
}

// Connection status for the configured accounts. Never exposes tokens. Feeds
// the future accounts/settings UI and is handy for verifying OAuth wiring.
export async function GET(): Promise<NextResponse> {
  const accounts = await prisma.account.findMany({ orderBy: { email: "asc" } });
  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      visible: a.visible,
      provider: a.provider,
      authMethod: a.authMethod,
      checkForConflicts: a.checkForConflicts,
      isDestination: a.isDestination,
      connected: Boolean(a.refreshToken || a.accessToken),
      // Connect link the UI can render for not-yet-connected accounts.
      connectUrl: `/api/oauth/${a.provider}/start`,
    })),
  });
}
