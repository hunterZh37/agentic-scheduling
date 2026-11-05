import { OAUTH_FLOW_MAX_AGE } from "@/lib/oauth/flowCookie";

/// The sign-in form's line for `?error=`, set by the shared Google callback so a
/// refused or failed attempt explains itself instead of bouncing silently back
/// to the form. Only known values pick a message; anything else is a generic
/// retry, since the query string is anyone's to craft.
export function loginMessage(error: string | undefined): string | null {
  if (!error) return null;
  if (error === "not_authorized") return "That Google account isn't the owner of this site.";
  if (error === "auth_not_configured" || error === "login_allowlist_empty") {
    return "Google sign-in isn't configured yet.";
  }
  if (error === "expired") return `That took too long. Start again and finish within ${OAUTH_FLOW_MAX_AGE / 60} minutes.`;
  return "Google sign-in didn't complete. Try again.";
}
