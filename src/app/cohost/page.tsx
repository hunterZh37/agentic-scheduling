import { redirect } from "next/navigation";
import { currentCoHost } from "@/lib/auth/coHostSession";
import { CoHostCalendars } from "./CoHostCalendars";

export const metadata = {
  title: "Co-host",
  robots: { index: false, follow: false },
};

// Colours come from the app's theme tokens (globals.css), never hard-coded hex,
// so the page is legible in BOTH light and dark — the dashboard runs dark, where
// near-black text on the dark ground was unreadable.
const S: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 560,
    margin: "0 auto",
    padding: "72px 20px 80px",
    fontFamily: "system-ui, sans-serif",
    color: "var(--text-1)",
    lineHeight: 1.6,
  },
  h1: { fontSize: 28, marginBottom: 6, letterSpacing: "-0.02em", color: "var(--text-1)" },
  sub: { color: "var(--text-2)", fontSize: 15, marginBottom: 32 },
  card: {
    border: "1px solid var(--hairline)",
    borderRadius: 14,
    padding: "20px 22px",
    background: "var(--surface-sunken)",
  },
  label: { color: "var(--text-3)", fontSize: 13, margin: "0 0 2px" },
  value: { color: "var(--text-1)", fontSize: 16, margin: "0 0 14px", fontWeight: 500 },
  note: { color: "var(--text-2)", fontSize: 14, marginTop: 24 },
};

export default async function CoHostHome() {
  const coHost = await currentCoHost();
  // The proxy already gates this route to a valid co-host session; this is the
  // defensive fallback for the impossible case (or local dev with no secret).
  if (!coHost) redirect("/login");

  return (
    <main style={S.main}>
      <h1 style={S.h1}>Welcome, {coHost.name.split(" ")[0]}</h1>
      <p style={S.sub}>You are signed in as a co-host.</p>

      <div style={S.card}>
        <p style={S.label}>Name</p>
        <p style={S.value}>{coHost.name}</p>
        <p style={S.label}>Email</p>
        <p style={S.value}>{coHost.email}</p>
        <p style={S.label}>Time zone</p>
        <p style={{ ...S.value, marginBottom: 0 }}>{coHost.timezone}</p>
      </div>

      <CoHostCalendars />

      <p style={S.note}>
        This page is yours: the owner&apos;s dashboard and private data stay
        separate from it, and your calendars are visible only to you.
      </p>
    </main>
  );
}
