"use client";

import { useEffect, useState } from "react";
import { PublicAgentChat } from "@/components/booking/PublicAgentChat";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

const DEFAULT_TZ = "America/New_York";

export default function AssistantPage() {
  const [tz, setTz] = useState(DEFAULT_TZ);
  useEffect(() => {
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ);
  }, []);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ marginBottom: 4 }}>Book time with {OWNER_FIRST_NAME}</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Tell me how long you&apos;d like and roughly when you&apos;re free — I&apos;ll
        find a time that works for both of you and book it.
      </p>
      <PublicAgentChat
        endpoint="/api/agent/requester"
        bookerTimezone={tz}
        durationMinutes={30}
        intro={`Hi! Tell me how long you'd like with ${OWNER_FIRST_NAME} and when you're free (with your timezone) — I'll find a time that works for both of you and book it.`}
        suggestions={[
          `Book 30 min with ${OWNER_FIRST_NAME} — I'm free Tue/Wed afternoons ET`,
          "I need 45 min next week, mornings work best (I'm in America/Los_Angeles)",
          "15 min this Friday afternoon",
        ]}
      />
    </main>
  );
}
