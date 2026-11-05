/// How long a sign-in or calendar connect may sit on the provider's screens,
/// in seconds. Was 10 minutes; an owner reading Google's "unverified app"
/// warning ran past that and landed on a bare /login (2026-11-05). Both flows'
/// cookies use it, and the sign-in form's "took too long" line quotes it.
export const OAUTH_FLOW_MAX_AGE = 30 * 60;
