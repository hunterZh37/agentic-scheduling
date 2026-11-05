/// What the connect callback reported, in words. The callback redirects back to
/// the page the person was on (`/` for the owner, `/cohost` for a co-host) with
/// `?oauth=<provider>&status=connected|error&email=…&reason=…`; both pages call
/// this so a failed connect explains itself in the same words in both places.
///
/// Pure and string-in, string-out so it runs in the browser and in tests.
/// Everything here arrives in a URL anyone can craft and send to the owner, so
/// nothing is echoed unless it has the shape it claims: `reason` and `oauth`
/// are only compared against known values, and `email` is shown only when it
/// looks like an address.
export type ConnectResult = { kind: "connected" | "error"; message: string };

const PROVIDER_NAMES = new Map([
  ["google", "Google"],
  ["microsoft", "Microsoft"],
]);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function readConnectResult(search: string): ConnectResult | null {
  const params = new URLSearchParams(search);
  const oauth = params.get("oauth");
  const status = params.get("status");
  if (!oauth || (status !== "connected" && status !== "error")) return null;

  if (status === "connected") {
    const email = params.get("email") ?? "";
    const shown = email.length <= 254 && EMAIL_RE.test(email);
    return { kind: "connected", message: shown ? `Connected ${email}.` : "Calendar connected." };
  }

  const provider = PROVIDER_NAMES.get(oauth) ?? "The provider";
  let message = "Couldn't connect that calendar. Try again.";
  switch (params.get("reason")) {
    case "invalid_state":
      message = "That connection expired. Try again.";
      break;
    case "access_denied":
      message = `${provider} access was declined. The account's admin may be blocking this app.`;
      break;
    case "already_connected":
      message = "That address is already connected on this site.";
      break;
    case "unknown_account":
      message = "That address already uses another provider here.";
      break;
    case "exchange_failed":
      message = `${provider} rejected the connection. Try again.`;
      break;
  }
  return { kind: "error", message };
}
