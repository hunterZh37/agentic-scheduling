import { ImageResponse } from "next/og";
import { teamForSlug, firstNamesLabel } from "@/lib/teams/resolve";
import { HOST } from "@/lib/booking/publicConfig";

export const OG_SIZE = { width: 1200, height: 630 };

// The team social-preview card, shared by opengraph-image and twitter-image so a
// /book/<slug> link never falls back to the owner's solo consulting OG image.
//
// Satori (next/og) rule: any element with MORE THAN ONE child must set
// display:flex explicitly — and a text node with an interpolation counts as
// multiple children, so titles are built as a single template string.
export async function renderTeamOgImage(slug: string): Promise<ImageResponse> {
  const team = await teamForSlug(slug);
  // Co-hosts first, owner last — consistent with the booking title/email.
  const members = team ? [...team.coHosts.map((c) => c.name), HOST.name] : [HOST.name];
  // Name the PEOPLE ("Ben & Hunter"), not the team's internal name (may be "Team").
  const name = team ? firstNamesLabel(members) : "our team";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "#0b0b0f",
          color: "#f5f5f7",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 30, height: 30, borderRadius: 999, border: "3px solid #0071e3", display: "flex" }} />
          <div style={{ fontSize: 22, letterSpacing: 4, color: "#8e8e93", fontWeight: 600 }}>AGENTIC SCHEDULING</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2 }}>
            {`Book time with ${name}`}
          </div>
          <div style={{ display: "flex", fontSize: 34, color: "#aeaeb2", marginTop: 26 }}>
            {"A shared link that only offers times you're all free."}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 34 }}>
            {members.slice(0, 5).map((m) => (
              <div
                key={m}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 22px",
                  borderRadius: 999,
                  background: "#1c1c1e",
                  border: "1px solid #2c2c2e",
                  fontSize: 28,
                }}
              >
                <div style={{ width: 12, height: 12, borderRadius: 999, background: "#0071e3", display: "flex" }} />
                {m}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "14px 26px",
              borderRadius: 14,
              background: "#f5f5f7",
              color: "#0b0b0f",
              fontSize: 28,
              fontWeight: 600,
            }}
          >
            bookwithhunter.com
          </div>
        </div>
      </div>
    ),
    OG_SIZE
  );
}
