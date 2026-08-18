// Decode (NOT verify) a JWT payload. Used only to read the `email` claim from
// an id_token we received directly from the provider's token endpoint over TLS,
// so signature verification adds nothing here — we already trust the channel.

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("Malformed JWT");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(payload, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}
