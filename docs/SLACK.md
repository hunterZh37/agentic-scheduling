# Scheduling agent in Slack

Puts the scheduling agent in a Slack channel. Distinct from Claude in Slack,
which is a coding assistant on your GitHub repos and knows nothing about this
calendar.

## Access model — read this first

WhatsApp is safe with the private agent because the sender is one phone number
you control. **A Slack channel is multi-user**: anyone in it can address the
bot. So the sender's Slack user id decides which agent answers.

| Sender | Agent | Can do |
|---|---|---|
| You (`OWNER_SLACK_USER_IDS`) | private | everything: read the calendar, create, move, cancel |
| Anyone else | public | free slots and booking only — never titles, attendees or details |

`isOwnerSlackUser` fails closed: an unset allowlist means **nobody** gets the
private agent, never everybody.

This is why the bot is safe to leave in a shared channel. Colleagues can book
time with you; only you can ask what's on your calendar.

## Setup

**1. Create a Slack app** at <https://api.slack.com/apps> → *From scratch*,
pick the workspace.

**2. OAuth & Permissions** → Bot Token Scopes:

| Scope | Why |
|---|---|
| `app_mentions:read` | see `@mentions` |
| `chat:write` | reply |
| `channels:history` | read messages in public channels it's in |
| `im:history` | direct messages (optional) |

Install to the workspace, then copy the **Bot User OAuth Token** (`xoxb-…`).

**3. Basic Information** → copy the **Signing Secret**.

**4. Find your Slack user id**: in Slack click your avatar → *Profile* → the
`⋮` menu → *Copy member ID*. It looks like `U08ABCDEF`.

**5. Set in Vercel** (Production and Preview), then redeploy:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
OWNER_SLACK_USER_IDS=U08ABCDEF
```

**6. Event Subscriptions** → enable, Request URL:

```
https://YOUR-DOMAIN/api/slack/events
```

Slack sends a one-time `url_verification` challenge; the route answers it. It
must show **Verified** before you continue. Subscribe to bot events:
`app_mention`, and `message.im` if you want DMs.

**7. In Slack**: `/invite @<your app name>` in the channel, then mention it.

## Notes

- **Replies land in a thread**, so a busy channel stays readable.
- **Slack demands a response in 3 seconds** and an agent turn takes longer, so
  the route acks immediately and replies via `chat.postMessage` from `after()`.
- **Slack retries** a delivery it thinks failed. The retry is acked and dropped
  (`x-slack-retry-num`), otherwise the agent runs twice and answers twice.
- **Non-owners are rate limited** per Slack user id, sharing the public agent's
  limiter. Owner messages are not limited.
- Order matters at setup: the Request URL can only verify once
  `SLACK_SIGNING_SECRET` is live in production.

## Watch

Anyone in the channel can address the bot. If `OWNER_SLACK_USER_IDS` were ever
widened, or the allowlist check made to default open, every member of that
channel would gain full read and write access to the calendar. The guard is
`src/lib/slack/verify.test.ts`.

## Agent-to-agent (A2A v1)

Another agent can address Alex in a channel. Slack is the transport; the
protocol adds only the two things Slack cannot say — what kind of message this
is, and how many hops the exchange has left.

```
<@U0ALEX> [a2a/1 ask ttl=5]
How do you handle memory between conversations?
```

| kind | Alex's response |
|---|---|
| `hello` | `hello`, deterministic — no model call, since it only asks who you are |
| `ask` | `reply`, answered by the **public** agent |
| `reply` | none — a Q&A is two messages and stops |
| `done` / `decline` | **never** — this is what gives an exchange an ending |

**A peer agent gets the public agent**, never the private one. It is not on
`OWNER_SLACK_USER_IDS`, so it can ask about availability and book time, and can
never see an event title or an attendee.

### Three guards, and why the third is the one that matters

1. **Never answer ourselves** — our own posts arrive back as events.
2. **`ttl`** — decremented on every reply; at zero Alex sends `done` rather than
   going quiet, because silence looks like a crash and invites a retry. This is
   cooperative and a peer can ignore it.
3. **A local count of consecutive agent messages in the thread**, from
   `conversations.replies`. A human message resets it. This is the only guard
   that survives the other agent being broken or hostile, and the easiest to
   leave out.

At the local limit Alex goes **silent** rather than sending `done`. That differs
from ttl exhaustion on purpose: a peer that has reached this point has already
ignored `ttl`, and anything Alex sends hands them another turn.

**If the thread cannot be read, Alex does not reply.** The guard that cannot be
verified is treated as failed — declining to speak is the safe direction.

### Slack setup A2A needs

`app_mention` is not enough. Slack only fires it for a REAL mention — a
`<@U…>` the sender picked from autocomplete. An agent posting programmatically
usually writes the handle as ordinary text, which Slack leaves as text, so no
event is delivered and Alex never sees the message. That is exactly what
happened on the first attempt.

Add the event **`message.channels`** (Event Subscriptions → Subscribe to bot
events) so Alex sees channel messages. Alex still only answers a frame that
parses as A2A **and** is addressed to it, by either a real mention or its
plain-text handle.

For private channels, add `message.groups` and the `groups:history` scope.

### Not A2A

Anything unparseable is ordinary text, not a broken frame: `a[0]` in a person's
message is never read as protocol. An unknown version is ignored rather than
guessed at, since a later version could change what today's fields mean.
Unknown header keys are skipped so a 1.x can add one.
