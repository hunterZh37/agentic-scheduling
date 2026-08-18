// Centralized, lazily-validated environment access. We intentionally do NOT
// throw at import time for the optional integration secrets — the OAuth layer
// is built to run against placeholders and only requires a given credential at
// the moment it makes a live call. `requireEnv` gives a clear error then.

export function optionalEnv(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

export function requireEnv(key: string): string {
  const v = optionalEnv(key);
  if (!v) {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Add it to .env (see .env.example).`
    );
  }
  return v;
}

export const APP_BASE_URL =
  optionalEnv("APP_BASE_URL") ?? "http://localhost:3000";

// Attendee-facing base URL (the public booking domain) used in links we email
// to bookers — e.g. the self-serve manage/reschedule link. Distinct from
// APP_BASE_URL, which is the Twilio-webhook host and must not change.
export const PUBLIC_BASE_URL =
  optionalEnv("PUBLIC_BASE_URL") ?? "http://localhost:3000";

export const DEFAULT_DESTINATION_EMAIL =
  optionalEnv("DEFAULT_DESTINATION_EMAIL") ??
  optionalEnv("OWNER_EMAIL") ??
  optionalEnv("HUNTER_EMAIL") ??
  "owner@example.com";
