export interface RequesterPersona {
  name: string;
  email: string;          // fictional, for flavor only
  goal: string;           // e.g. "a 30-minute intro chat"
  durationMinutes: number;
  timezone: string;       // IANA
  availability: string;   // natural-language free windows
}

/// Preset simulated requesters for the negotiation demo. Availability is stated
/// in plain language; the requester agent converts it to concrete times.
export const PERSONAS: RequesterPersona[] = [
  {
    name: "Ada Lovelace",
    email: "ada@example.com",
    goal: "a 30-minute intro chat about a possible collaboration",
    durationMinutes: 30,
    timezone: "America/New_York",
    availability: "Tuesday and Wednesday afternoons",
  },
  {
    name: "Grace Hopper",
    email: "grace@example.com",
    goal: "a quick 15-minute sync",
    durationMinutes: 15,
    timezone: "America/Chicago",
    availability: "Thursday or Friday late mornings",
  },
  {
    name: "Alan Turing",
    email: "alan@example.com",
    goal: "a 45-minute deep-dive on a project",
    durationMinutes: 45,
    timezone: "Europe/London",
    availability: "weekday late afternoons, his time",
  },
];

/// Pick a persona by index, wrapping safely for any integer.
export function pickPersona(index: number): RequesterPersona {
  const n = PERSONAS.length;
  return PERSONAS[((index % n) + n) % n];
}
