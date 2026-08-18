# Regression ledger

Every bug reported from actually using this site, and what stops each one coming
back. Fixing one thing and breaking another is the failure mode this file exists
to prevent.

**Before every push:**

```bash
npm run verify     # tsc + unit tests + live smoke checks
```

`npm run lint` is deliberately NOT part of `verify`. The repo carries a
pre-existing backlog of 8 eslint errors (mostly `setState` inside an effect,
plus one `<a>` that should be a `next/link`), none of them introduced by the
fixes below. Gating every push on a check that already fails would train you to
ignore it. Run it separately and burn the backlog down when convenient.

A **pre-push hook** (`.githooks/pre-push`) blocks any push that fails typecheck,
tests, or — when the push touches a `.css` or `.tsx` file — the mobile audit,
which it runs against a dev server it starts itself. Layout is a property of the
code, so unlike smoke it is meaningful BEFORE a push.

It also requires `GET /api/health` on the deployed site to be **200**
(`database`, `api`, `agent`). That check describes production as it stands
*before* the push, so it says nothing about the code being pushed — it is there
to stop you layering a change onto an already-broken system. When production is
down and **this push is the fix**, skip just that gate with
`SKIP_HEALTH=1 git push`, which still runs typecheck, tests and the mobile
audit. A 404 (endpoint not deployed) or no network is reported, not blocked:
absent is not unhealthy. It runs automatically; on a fresh clone enable it with
`npm run hooks:install`. It deliberately does NOT run smoke — smoke checks the
currently deployed site, so gating on it would block the one push that matters
most, the fix for a live outage. Emergency escape hatch: `git push --no-verify`.

`npm run smoke` alone hits a running deployment. Run it **after** a deploy goes
live too — the checks below marked `smoke` cover failures that are invisible to
unit tests, because they come from environment variables, the proxy matcher, or
production data rather than from code.

Guard column: `test` = automated unit test, `smoke` = live check in
`scripts/smoke.mjs`, `manual` = no automation, must be eyeballed.

**Adding to this list is not optional.** The workflow any agent must follow when
a bug is reported — reproduce, add a row here, add a guard, `npm run verify`,
re-run `npm run smoke` after deploy — is written into `AGENTS.md`, which is
loaded automatically at the start of every session. Say "add this to the
regression list" if it is ever missed.

---

## Booking availability

| # | Symptom you reported | Cause | Guard |
|---|---|---|---|
| 1 | "No open times" on **every** day, indefinitely | A repeating block with an end date was stored as one 21-day span that then repeated daily; occurrences overlapped into unbroken busy time | `test` `src/lib/recurrence/until.test.ts` · `smoke` open-times check |
| 2 | Reserved block listed ~9 times in one day | A block longer than its recurrence interval produced overlapping occurrences; clamped to a day they were identical | `test` `src/lib/availability/recurrence.test.ts` |
| 3 | Busy times offered as free on wide date ranges | Free/busy fanned out over the raw request; providers reject over-wide ranges and a failed account contributes no busy time | `test` `src/lib/availability/service.test.ts` |
| 4 | Booking page crashed on malformed input | Route read fields without shape checks and echoed raw errors back | `test` `src/lib/validation.test.ts` · `smoke` duration check |
| 23 | Assistant said "just one opening this Thursday afternoon" while the picker listed 8 slots that day — and the same question answered differently on a re-run | The agent chose its own cut-off for a vague word, queried only that slice, and never saw the rest of the day | `test` `availabilityTool.test.ts` (the tool widens + returns both buckets) + `partitionSlots.test.ts` (the split itself) |
| 22 | Booking page offered 4:30pm while a 4:30pm actionable was on the agenda | Actionables are deliberately not mirrored to a provider calendar (see #12), so they contributed no busy time to ANY availability computation | `test` `src/lib/availability/service.test.ts` (behaviour) + `busySources.test.ts` (all three paths) |

**Watch:** a block spanning multiple days *and* repeating is the dangerous
shape. Non-repeating spans (a weekend hold) are legitimate and must keep working.

`busySources.test.ts` enforces this at the source level: it reads the three
files and fails if any of them stops counting provider events, reserved blocks
or timed actionables — and fails if a FOURTH module starts fanning out free/busy
without being added to the list. No behavioural test would notice either.

Two layers on purpose: `partitionSlots.test.ts` covers the pure split, but it
passes even with the day-widening reverted — verified. `availabilityTool.test.ts`
is the one that holds the guarantee, asserting the tool queries a full local day
whatever window it is handed and never returns a bare `slots` list again.

**Watch:** the two booking tabs must agree. "Pick a time" lists slots directly;
the assistant reaches them through `get_availability`, which now always searches
the whole owner-local day and returns `matching` + `alsoFreeSameDay`. Narrowing
that query to the visitor's phrasing is what made the assistant look empty while
the picker was full.

**Watch:** busy time is computed in THREE places — the visitor's slot list
(`availability/service.ts`), the guard that accepts a booking
(`booking/service.ts`), and the Calendly cross-check
(`api/availability/check`). A new source of busy time must reach all three.
Hiding a slot on the page without guarding the write still lets a direct API
call book over it.

## Auth and access

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 5 | Private API reachable with no session via `/api/todos/<id>.js` | Proxy matcher's static-asset exemption swallowed API routes | `smoke` suffix-bypass check |
| 6 | Site guarded only by a shared password | — | `test` `src/lib/auth/ownerLogin.test.ts` (allowlist fails closed) |
| 7 | Google sign-in bounced silently back to the form | `redirect_uri` pointed at the `vercel.app` host, so the session cookie was set on a host the user was not on | `smoke` redirect-host check |
| 8 | `Error 400: redirect_uri_mismatch` | Callback URI not registered in Google Cloud Console | `smoke` Google-accepts check |
| 9 | "That Google account isn't the owner" for a valid account | Allowlist fell back to the destination account, which is a **Microsoft** address, so no Google identity could ever match | `smoke` allowlist-not-empty (503) · server log names the refused address |
| 10 | Visitor pages 404/redirect after being added | New public route not added to `PUBLIC_PREFIXES` in `src/proxy.ts` | `smoke` public-pages check |

**Watch:** adding a visitor-facing page means updating `PUBLIC_PREFIXES`, not
just its API route. Sign-in scope must stay `openid email` — never calendar.

## Calendar writes and sync

**Watch:** an actionable's day-key must follow its start time. The two views
read different fields — Blocks queries `date`, the calendar places by
`startTime` — so any write that moves one without the other splits the item
across two days, and neither view looks wrong on its own.

**Watch:** Google ignores `conferenceData` unless `conferenceDataVersion=1` is
on the URL, and ignores it SILENTLY — a normal event comes back with no link and
no error. `createDestinationEvent` returns `{ id, videoLink }` rather than a
bare id; tsc cannot catch a caller that forgets, because every call site does
`JSON.stringify({ eventId })`, which serialises an object just as happily.

**Watch:** any entity the agent can create, it must also be able to SEE and
UPDATE. A create-only tool guarantees duplicates the moment the owner asks for
a change, because creating another is the only move available.

**Watch:** an instruction in a tool description is advice to a model, not a
guard, and it will be ignored eventually. Write-tools the agent can reach must
be idempotent in CODE. The specific trap here: conversation history reaches the
model as plain text, so it has no structured record of its own past tool calls —
only what it said it did. Re-issuing a create while summarising earlier turns is
therefore a normal failure, not an aberration, and every create the agent owns
should assume it will happen.

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 11 | Agent created duplicate events | Retry wrapper retried non-idempotent POSTs | `manual` — creates use plain `fetch`; retries only update/delete |
| 12 | Actionables showed as both ACTIONABLE and EVENT | Actionables were mirrored to the provider calendar | `manual` — actionables are first-class, never mirrored |
| 27 | Agent moved an actionable: the calendar showed it on the new day, the Blocks checklist kept it on the old one | An actionable stores BOTH a `date` day-key (what Blocks queries) and a start/end (what the calendar places it by). `update_actionable` rewrote only the times, so one record claimed two days | `test` `src/lib/agent/actionableDayKey.test.ts` |
| 28 | Clicking a booking in the Blocks agenda did nothing | `openDetail` was an inline ternary over block/event/todo that fell through to `undefined` for any other kind — so the row was not a button, while the SAME booking opened fine from the calendar grid | `test` `src/components/blocks/detailItem.test.ts` |
| 29 | "When I click on the test booking, the detail panel does not open up" — the row under **Upcoming bookings** | #28's fix wired the *agenda* booking rows only; the Upcoming-bookings section rendered a plain summary row with no click handler at all (its `BookingRow` didn't even carry `endTime`/`attendeeEmail`, so the modal couldn't have been fed). The mapping is now shared: `agendaDetailItem` / `upcomingBookingDetailItem` in `src/components/blocks/detailItem.ts`, so every booking surface opens the identical modal | `test` `src/components/blocks/detailItem.test.ts` (this fix also created that file — #28's row had named it as its guard, but it was never written) |
| 26 | An event created through the app had no video-call link | The create call sent title, time, location and attendees and nothing else — no `conferenceData`, so no Meet was ever minted. Only BOOKINGS had a link, and that was the single static `NEXT_PUBLIC_OWNER_VIDEO_LINK` room reused for every one | `test` `src/lib/calendar/conference.test.ts` |
| 21 | Same actionable created three times ("Fetch the car") | `create_actionable` was the agent's ONLY actionable verb, and `get_schedule` didn't return actionables — so asked to retime one it could neither see nor update it, and made another | `test` `src/lib/agent/actionableTools.test.ts` |
| 42 | Asked for a SECOND actionable in a follow-up turn; the agent created it and re-created the first, leaving "Put together all the immigration things" twice at 8–10 PM | Not a missing verb this time — #21 already added list/update/delete. `run.ts` replays history to the model as plain role + content, so a previous tool call leaves no structured trace: the model's only memory of having acted is its own prose, and it re-created both items while composing a combined "both are on tonight's list" confirmation. `list_actionables` says "ALWAYS call this before creating" — advice, not a guard | `test` `src/lib/agent/actionableDuplicate.test.ts` — `create_actionable` is now idempotent on (day, title, start, end) and returns the existing item |
| 13 | 503 adding an event to the Outlook calendar | — | `test` `src/lib/calendar/microsoft.test.ts` |
| 14 | Calendar showed the 25th when it was the 30th | Page was statically prerendered, baking "today" into the HTML at build time | `manual` — `export const dynamic = "force-dynamic"` on `src/app/page.tsx` |

## Reminders

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 15 | Events could not set reminders | Only todos rendered the control | `manual` |
| 16 | Same fire time listed twice / duplicate reminder at one time | — | `test` `src/app/api/reminders/route.test.ts` |
| 17 | Reminder panel cut off on the right on a real phone | Native `datetime-local` has an intrinsic min-width that overflowed its container | `manual` — needs a real device viewport, see below |

**Watch:** do **not** set `font-size: 16px` on native date/time inputs. There is
a deliberate exemption in `globals.css`; iOS does not zoom those, and forcing
the size widens the control and reintroduces #17.

## Mobile

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 46 | Confirmation panels and sheets were never checked on a phone | `audit:mobile` loaded five PUBLIC PAGES and never opened an overlay, so every dialog, sheet and modal was outside it — and it reported "mobile clean" the whole time. Opening them found: the calendars "Bookings" badge hanging 33px off a 320px screen, two date inputs overflowing the block sheet, a 15px input (iOS zooms and never zooms back), and ~100 controls under the 44px tap floor including both ConfirmDialog buttons | `audit:mobile` now opens 6 overlays per device (18 per run) and measures inside them; runs in the pre-push hook whenever `.tsx`/`.css` changes |

**Watch:** an audit that only visits pages will pass forever while every
interactive surface is broken. Anything reachable only after a click — a dialog,
a sheet, an inline card — has to be opened by the audit or it is not covered.
Adding a new overlay means adding a scenario to `OVERLAYS`.

**Watch:** on a phone the dashboard shows one pane at a time behind tabs, so a
control in the Blocks pane is `display:none` until its tab is selected. The
first version of the overlay pass silently timed out on five of six scenarios
for exactly this reason.

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 47 | React "Encountered two children with the same key" on every dashboard load — meaning it may DROP or duplicate a calendar tile | A calendar item's React key was `item.id`, which is an identity (`event:<providerId>`), not an occurrence. Two separate collisions: a recurring series returns the same provider id for every occurrence, and a meeting present on TWO connected calendars comes back twice with the same id *and* the same start. The key now carries the start and the account; `item.id` is left alone because EventModal parses it for the provider id on edit/delete, and `followupKey` builds occurrence keys from it | `audit:mobile` fails on console errors, and the pre-push hook runs it against a DEV server where React logs this warning — a production build stays silent |

**Watch:** the mobile audit's console-error check is the only thing in the repo
that catches React key/hydration warnings, because it is the only check that
runs against a dev build. That is why the hook starts a dev server rather than
reusing the production one.


| # | Symptom | Cause | Guard |
|---|---|---|---|
| 18 | iOS zoomed in when focusing a field | Input font smaller than 16px | `test` `npm run audit:mobile` (pre-push) |
| 38 | A reminder that failed to deliver still read as sent | `sentAt` was set when Twilio ACCEPTED the message; the delivery failure arrives later on the status webhook, which only resent as SMS and never wrote back to the reminder | `test` `src/app/api/sms/statusReminder.test.ts` |
| 37 | Neither the WhatsApp nor the email reminder arrived, while all three rows read `sentAt`, `attempts: 1`, `failedAt: null` | Two independent faults. (a) The owner's email resolved through the `DEFAULT_DESTINATION_EMAIL` chain — the same one that ends at `owner@example.com` — which the reputation fix corrected only for its own cron. (b) Twilio ACCEPTING a WhatsApp message is not delivery: it failed later with 63049 on the status webhook, and the SMS fallback failed too (the number is A2P-unregistered) | `test` `src/lib/notify/ownerEmail.test.ts` · recipient now logged per send |
| 36 | A booking's detail panel offered no way to cancel it | `canEdit` covers events and actionables, so no action rendered for a booking. Cancelling meant closing the panel and finding the row in "Upcoming bookings" | `test` `src/components/calendar/bookingCancel.test.ts` |
| 35 | A booking's detail panel showed the time and the guest but no way to join | Booking detail items were built with id/kind/title/start/end/attendees and no `videoLink`, in all three surfaces. The invite and the confirmation email carried the owner's room link the whole time — only the owner's own dashboard could not see it | `test` `src/components/blocks/detailItem.test.ts` |
| 34 | Four fixes in, the times were still cramped on the reporter's phone — reproduced correct in emulation every time, wrong on the device every time | The inline slot column has to share one card with the calendar, so its height is always someone else's leftovers. Each fix traded one cramped shape for another. Replaced rather than tuned: picking a day now opens the times in a dialog, which owns the screen | `test` `npm run audit:mobile` (phones) · measured at 6 viewports |
| 33 | On Aug 8 the card showed only 6:30 AM and 12:30 PM, with the next row sliced off by the card's edge | `.body` had a hard `height: 540px` and `.window` has `overflow: hidden`, so any day with more times than fit was CLIPPED, and the remainder lived behind an inner scrollbar. The three earlier attempts all tuned that scrollbar instead of removing the cap | `test` `npm run audit:mobile` (phones) · measured at 7 viewports |
| 32 | "The scrollable area for the slots is too small for anyone to see the available slots" | The DESKTOP layout, which I had not measured: the slot column was a fixed 200px wide — one time per row — and took its height from the mini-month beside it, giving a 346px scroller showing **6 of 25** openings. Reported as a mobile problem, so two rounds of mobile CSS were shipped before the desktop layout was ever checked | `test` `npm run audit:mobile` covers phones only — desktop is `manual` · measured |
| 31 | Booking on a phone was hard: every opening on its own row, most of them below the fold, and picking a day appeared to do nothing | The slot list kept the desktop shape — one full-width time per row — which stacked to 888–1504px on a phone. And the calendar sits ABOVE the times on mobile, so a freshly picked day rendered its openings off-screen | `test` `npm run audit:mobile` (pre-push) · measured |
| 30 | "The scrollable area for the slots is really small" on a phone | The slot list kept its desktop behaviour — a flex column with `overflow-y: auto`, capped at 320px on mobile — so the times scrolled INSIDE the page scroll. Two nested scroll regions, and on a day with one opening the box collapsed to a 46px sliver | `test` `npm run audit:mobile` (pre-push) · measured |
| 19 | Tap targets below the 44px minimum | Booking date cells 34px, month arrows 28px, timezone select 20px tall | `test` `npm run audit:mobile` (pre-push) |

Audit at real viewports (iPhone SE 320px / iPhone 13 390px / Pixel 7 412px),
public pages, last run 2026-08-05:

- No horizontal overflow, no console errors, no input under 16px (nothing that
  triggers iOS zoom), viewport meta does not block pinch-zoom.
- Booking date cells, month arrows, timezone select, assistant chips and footer
  links were all under 44px; now 44px tall.

**Watch:** the booking flow finishes INSIDE the dialog — times, then details.
Picking a time must not return the visitor to the page behind it; the bottom
`confirmBar` is a fallback for when the dialog is closed, and renders only then.

**Watch:** the day's times live in a DIALOG (`slotDialog`), not in the card. The
card must never regain responsibility for showing a variable-length list beside
a fixed-size calendar — that is what made this take five attempts. The dialog
body may scroll; it is the only thing on screen when it does.

**Watch:** the inline times list is NOT a scroll container at any width, and `.body` has a
`min-height`, never a `height`. A fixed-height card plus `overflow: hidden`
clips the day; an inner scrollbar then hides the rest from anyone who does not
notice it. The page is what scrolls.

**Watch:** the booking page has TWO layouts and the mobile audit only measures
one. Above 768px the times are a scrolling column whose height comes from the
calendar beside it; below, they stack and the page scrolls. A complaint about
"the slots area" has to be reproduced at the reporter's actual viewport before
changing anything — measuring the wrong one costs two deploys.

**Watch:** a scroll region nested inside the page scroll is the wrong shape on a
phone. The slot list is a scrolling column on desktop only, beside a
fixed-height calendar; on mobile it must be its natural height and let the page
scroll.

**Watch:** seven date columns at a fixed 44px overflow a 320px phone sideways.
The cells cap their WIDTH at 44 and stay fluid, so on iPhone SE they are 35x44 —
as wide as the viewport allows without trading a touch bug for a layout one.
Re-check horizontal overflow after any change to the date grid.

Accepted as-is: inline links inside prose on /privacy and /terms are ~18px tall.
WCAG 2.5.8 exempts links in a sentence, and padding them out would wreck the
line spacing. Short footer links (Privacy 41px, Terms 35px wide) are full height
but narrower than 44 — that is just the width of the word.

## Site reputation

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 24 | No daily reputation audit arrived | TWO faults. (a) It emailed only when the vendor list CHANGED, so a quiet day was silent. (b) No recipient env var was set in production, so the fallback chain ended at the literal `owner@example.com` — a reserved domain. Resend accepted it and the cron logged 200, so it reached nobody even on a change day | `test` `check.test.ts` (digest always has a body) + `ownerEmail.test.ts` (send refuses unroutable, recipient falls back to the destination account) |
| 20 | Domain blocked as "Phishing" on public WiFi | A 2-day-old domain served a bare, unbranded password box at the root — the credential-harvesting signature | `smoke` booking-page identity + security.txt/robots.txt · daily VirusTotal watch |
| 39 | FortiGuard re-reviewed the domain and KEPT the Phishing rating, after a dispute citing all the identity work | The reviewer could not see any of it. TWO faults, both invisible to every guard we had. (a) `GET /` answered `307 → /login`, so the domain's front door — the URL every crawler fetches first — was a sign-in form. (b) Every public page is client-rendered, so the served HTML's only text was its own `<title>`: `/book` was 11.5 KB with zero words in the body. The identity, privacy/terms links and explanation we kept pointing reviewers at existed only in a JS bundle. The old "booking page states who it belongs to" check passed by searching the JS chunks, so it stayed green the whole time and gave false confidence | `test` `proxy.test.ts` (anonymous `/` → `/book`, never `/login`; dashboard still gated) + `smoke` `/` must not redirect to sign-in · `/book` and `/login` must carry identity in the HTML **as sent**, not in a bundle |

**Watch:** `sentAt` on a Reminder means "the provider accepted it". A WhatsApp
failure arrives minutes later on `/api/sms/status`, which now clears `sentAt`
and sets `failedAt` on the reminder that asked for the message — correlated via
a `reminderId` on the callback URL, since Twilio echoes it back. Twilio signs
the FULL callback URL, so the signature check must include the query string;
verifying the path alone worked only while no parameters existed.

**Watch:** a fallback address must never be a reserved example domain. Mail to
`example.com` is accepted by the provider and delivered to nobody, so the send
path reports success and the failure is invisible. `sendEmail` now throws on
those, and owner mail resolves through the destination calendar account rather
than a constant.

**Watch:** an audit the owner relies on must send on a schedule, not only on
change. Silence has to mean "nothing ran", never "nothing to say" — otherwise a
broken job is invisible for as long as the news happens to be good.

**Watch:** the login page must keep real identity — who the site belongs to, a
path to public pages, privacy/terms. Stripping it back to a bare password box is
what caused the original classification.

**Watch:** for reputation, only the HTML **as sent** counts. Reputation crawlers
do not run JavaScript, so identity content that a client component paints in
after hydration does not exist as far as they are concerned. A guard that greps
the JS bundle proves the code shipped, not that a reviewer can read it — assert
on the response body. `/login` is a server component and `/book` carries a real
`<noscript>` fallback for exactly this reason; making either fully client-side
again silently undoes the fix while every check stays green.

**Watch:** `/` must not redirect anonymous visitors to sign-in. It is the first
URL any scanner fetches, and a login form there reads as credential harvesting
on a young domain. Send them to `/book`; the owner still gets the dashboard at
`/` once signed in.

---

## Event / booking detail panel

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 43 | "Cancel booking" rendered on top of the booking's title | The header controls were absolutely positioned over the card, and `.head` reserved a fixed `padding-right: 96px` to clear them — a number measured when the only controls were "Edit" and "×". "Cancel booking" is far wider, so a long title ran underneath it | `manual` — visual. Title and controls now share one flex row, so no reserved-space number can go stale; a long title wraps the controls onto their own line |
| 49 | Booking panel header always broke into two rows — title, then a mostly-empty line holding just "Cancel booking" + ×, then a gap before the details | Row 43's fix gave the title `flex-basis: 58%`, so the wrap decision ignored the title's REAL width: 58% of the card plus the booking controls can never fit on one line, making the "long title" fallback the permanent layout. The 448px card also left only ~206px beside the controls — narrower than a typical "First Last <> Hunter" title | `manual` — visual. Title basis is `auto` (wrap only when the title genuinely doesn't fit) and the card is 540px wide, verified live with a real booking at both title lengths |
| 50 | "I cannot click on 'Review Keith's' actionable when there is no time attached to it" — every other actionable opens the editor on a title click, this one did nothing | UNtimed to-dos render in their own list (`untimedTodos`), separate from the timed agenda. That block's `.rowBody` never got the `role="button"`/`onClick` wiring the timed rows have via `agendaDetailItem` — the same "row silently isn't clickable" class as #28/#29, but for the one item type with no start/end (which is also why it couldn't feed the editor, since the editor always shows a time) | `test` `src/components/blocks/detailItem.test.ts` — `untimedTodoDetailItem` builds the actionable detail with a default 9:00 AM slot on its day so the row opens the same `EventModal`; verified locally end-to-end |
| 51 | The booking popover was inconsistent with event/actionable: a bare "Cancel booking" in the header instead of the Edit button, and no way to change a booking's time and re-invite the attendee | A booking was deliberately non-editable (`canEdit` excluded it) on the theory that "the time belongs to the attendee". But the header then diverged from every other kind, and the only way to move a booking was to cancel and re-book. Bookings are now editable like events/actionables: same Edit button, "Cancel booking" moved into edit mode. Saving a time change routes to a new owner endpoint (`PATCH /api/bookings/[id]`) that calls `rescheduleBooking` — books the new slot, drops the old — so the provider sends the attendee an updated invite; a reschedule always notifies (no silent move) | `test` `src/app/api/bookings/[id]/route.test.ts` — the reschedule endpoint validates the range and forwards start/end/title to `rescheduleBooking`; header/edit flow verified locally end-to-end |

**Watch:** clearing an absolutely-positioned control with a hard-coded
`padding-right` on its neighbour breaks silently the next time a label changes
or a button is added. Put them in the same flex row and let layout do it.

**Watch:** hover is a POINTER capability, not a screen size. Gating a
hover-revealed control's touch fallback on `max-width` leaves it permanently
invisible — but still tappable — on any wide touch device. Use
`@media (hover: none)`. And a destructive control that is invisible until hover
should not fire on a single press: a miss and a hit look identical.

---

## Blocks pane

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 44 | Deleted a duplicate actionable; it was still there afterwards. Pressing ✕ again did nothing at all — not even the confirmation the owner expected | THREE faults stacked. (a) `.rowDelete` is `opacity: 0` and revealed by `.row:hover`; the touch fallback was gated on `max-width: 768px`, so on a WIDE touch device (an iPad in landscape, which is how this dashboard is used) neither rule applied — the control was permanently invisible while still being tappable, so the owner was aiming at nothing. (b) There was no confirmation step, so a hit deleted outright and a miss did nothing — indistinguishable. A first attempt at fixing this armed the ✕ into an inline "Delete?" button, which was a second bespoke pattern for something the app already had a component for. (c) `deleteTodo` never inspected its response, so a failure and a no-op looked the same. Confirmed against production: both rows still present, created 21s apart, neither ever deleted | `manual` — visual. Revealed by `@media (hover: none)` rather than by width; ✕ opens the same ConfirmDialog the reserved blocks and booking cancellations use; failures are surfaced. Verified locally end-to-end: 3 rows → 2, correct row gone |

---

## Upcoming bookings

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 45 | A cancelled meeting still showed as "Confirmed" in Upcoming bookings | The status pill was the hard-coded string `Confirmed` — it never read `bk.status`, so any cancelled booking reaching that list announced itself as confirmed. Compounding it, the list filtered to `status === "confirmed"`, so the normal outcome was the row silently vanishing, which is indistinguishable from a meeting that was never made | `manual` — visual. The pill reads the real status, and cancelled bookings stay listed (struck through, muted, no ✕) until their slot passes |

A cancelled booking now clears itself 24h after cancellation, or immediately
via the trash control on its row. The deadline keys off `updatedAt` — nothing
writes to a booking after it is cancelled — which avoids a `cancelledAt` column
and a manual production migration for a cosmetic rule. Dismissals persist as a
namespaced key in the generic `Checkoff` store, so they hold across devices
without a schema change, and hide the row rather than deleting the record.
Guarded by `src/components/blocks/upcomingBookings.test.ts`.

**Watch:** a status label must be derived from the record, never written as a
literal in the markup. A hard-coded "Confirmed" cannot be wrong until the day
something cancelled reaches it, and then it lies with total confidence.

**Watch:** the app only knows about cancellations made THROUGH it — the booking
page's manage link, the dashboard, or the agent. Deleting the event directly in
Google Calendar leaves the Booking row `confirmed`, and nothing here will show
it as cancelled.

---

## Calendars manager

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 40 | Renamed a calendar to "consulting"; the alias showed in the Calendars manager and nowhere else | The legend, the calendar's own legend and the event detail each fetched `/api/accounts` independently and mapped straight to `a.email`, discarding `displayName` — even though the schema comment says the name is "shown in the Calendars manager **and legend**" | `test` `useAccountLabels.test.ts` + one shared `useAccountLabels()` hook, so a new view cannot reintroduce the raw address by mapping the payload itself |
| 41 | Buttons in a calendar row were unreadable — "Send bookings here Remove Done" ran together and didn't look like controls; the rename field showed ~7 characters | All of it was bare coloured text crammed onto one flex row with the name. The armed "Remove?" was also wider than the ✕ it replaced, so it overflowed the panel and was clipped mid-word | `manual` — visual. Actions moved to their own line with real button surfaces, Remove is an ✕ until armed, the row wraps. No automated guard: the mobile audit catches overflow of the page, not of a panel |

**Watch:** the colour of a calendar keys off its **address** (`accountVar(email)`),
never its label. Keying colour off a renameable string would recolour every
calendar the moment it was renamed, and the legend is how you know which event
belongs to which account.

---

## Agent capability parity

**Watch:** anything the agent can create it must also be able to SEE and CHANGE.
A create-only or cancel-only surface guarantees the wrong workaround: with no
`update_actionable` it made duplicates (#21), and with no `reschedule_booking` a
move over WhatsApp meant cancel + rebook — which emails the attendee a
cancellation, then a fresh invitation, and invalidates their manage link.

The WhatsApp/SMS channel runs the PRIVATE agent, so a tool added there is
immediately available over WhatsApp. Current booking verbs: create, reschedule,
cancel (`src/lib/agent/bookingTools.test.ts`).

## Morning brief

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 25 | Brief read "3 items: 12:00 AM Sleep · 9:00 AM CS and ELA CAMP · 11:00 PM Sleep" | It merged reserved BLOCKS as items. A nightly block appears twice in one day — the tail of last night and the start of tonight — burying the one thing actually happening. Actionables were absent altogether | `test` `src/lib/brief/morning.test.ts` |
| 51 | "The daily tells me that there is not events, but that is not true" — the 7:01 AM brief said "nothing on your calendar. An open day ahead." while two recurring CS sessions (on the Outlook account since May/July, confirmed via Graph `createdDateTime`) sat on the day | A transient failure fetching that one account at send time (token refresh and Graph fetch are single-shot; either can flap). `getScheduleView` correctly degrades a failed account to a `warnings` entry — but the brief ignored `warnings` entirely, so "one calendar unreadable" rendered identically to "genuinely open day". Prod returned both events with zero warnings when re-queried at 11 AM | `test` `src/lib/brief/morning.test.ts` — the schedule fetch retries once when a view carries warnings, formatters never claim an open day while a calendar is unreadable (they name the account instead), and warnings that survive the retry are logged by the route so the next flap is visible in Vercel logs |

**Watch:** the brief covers what HAPPENS in a day — events, timed actionables,
bookings, birthdays. Reserved time is the shape of the day, not an item in it,
and a recurring block will always appear twice at the day's edges.

## Daily reputation audit

Runs `0 16 * * *` (09:00 PT) via `/api/cron/reputation`. Sends **every day**,
not only on change — see #24 for why silence is unacceptable here.

- **Email** → `ownerEmailAddress()`: `OWNER_EMAIL`, else the destination
  calendar account. Never a placeholder; `sendEmail` throws on reserved example
  domains.
- **WhatsApp** → `OWNER_WHATSAPP_NUMBER` (or `OWNER_SMS_NUMBER`) from
  `TWILIO_WHATSAPP_FROM`. Best-effort: a Twilio failure must not 500 the cron
  after the email is away, nor block the snapshot marker.

**Watch:** WhatsApp blocks business-INITIATED messages outside the 24h reply
window unless they use a pre-approved template. This cron fires at 09:00 with no
conversation open, so without `TWILIO_REPUTATION_CONTENT_SID` the freeform path
is normally rejected with error 63016. The cron response reports
`whatsapp: template | freeform | failed | not_configured` so this is visible
rather than silently dropped.

## Slack channel

The scheduling agent in Slack (`docs/SLACK.md`). The sender's Slack user id
picks the agent: owner → private (full access), anyone else → public (free slots
and booking only).

**Watch:** unlike WhatsApp, where the sender is one phone number the owner
controls, a Slack CHANNEL is multi-user — every member can address the bot. If
the owner check ever defaults open, or the allowlist is widened, everyone in
that channel gains full read/write access to the calendar. `isOwnerSlackUser`
fails closed and is guarded by `src/lib/slack/verify.test.ts`.

**Watch:** the signature covers the RAW request body. Verifying after a JSON
parse round-trip fails, because re-serialising changes the bytes.

## Agent-to-agent (Slack)

`src/lib/slack/a2a.ts` — see `docs/SLACK.md` for the protocol.

**Watch:** the local consecutive-agent counter is the only loop guard that
survives a peer ignoring `ttl`. It is also the easiest to delete, because
everything looks fine while the peer is well-behaved. Two agents in a shared
channel spend money at machine speed; `a2a.test.ts` asserts the limit holds even
against a peer claiming `ttl=99`.

**Watch:** health `fail` must mean "cannot send now", never "something failed
earlier". A past delivery failure is a `warn`: it still alerts through the
monitor, but it does not 503 `/api/health`, because that gates the pre-push hook
and would block every push for 24h after one undelivered message — including the
push fixing it. This happened on the A2A push and is why the distinction exists.

**Watch:** with BOTH `app_mention` and `message.channels` subscribed, Slack
delivers a mention TWICE — once as each. Alex answered both, which reads as a
loop and is what Carl called out before disengaging. Deduplicated by source: a
`message` containing `<@self>` is dropped because `app_mention` already covered
it; a `message` without one is the plain-text handle case that fires no
`app_mention` at all.

**Watch:** the peer agent needs its own identity. Answering a peer with the
public agent made Alex introduce itself as "a scheduling assistant", deny being
Alex, and reply to a plain question with a booking prompt.

**Watch:** a message from a bot is answered ONLY when it parses as A2A. Treating
unparseable bot text as an ordinary message would let two agents converse
without any of the guards.

## Messaging pipelines

`checkMessaging()` (`src/lib/notify/health.ts`) — Resend credentials, a
resolvable owner address, Twilio credentials and account status, the WhatsApp
sender, the approved reminder template, an owner number, and any reminder that
failed to deliver in the last 24h. **Sends nothing**: configuration plus
read-only credential probes, so it is free to run on a schedule.

- **Periodically** — folded into `/api/cron/monitor` (every 4h), which already
  alerts over WhatsApp and email. Deliberately not a separate cron: one more
  scheduled job is one more thing that can quietly stop.
- **Before a push** — `health.test.ts` (each failure mode),
  `sendersFailLoudly.test.ts` (the structural one), and
  `pipeline.e2e.test.ts`, which drives a due Reminder row all the way to the
  outbound HTTP request with only `fetch` faked. It asserts the owner's address
  comes from the destination calendar and is never a placeholder, that WhatsApp
  goes as an approved template rather than freeform, that the StatusCallback
  carries the reminder id, and that a provider rejection dead-letters instead of
  reporting success. Verified to fail when either of those regressions is
  reintroduced.
- **On demand** — `npm run test:messaging -- --send` sends one real email and
  one real WhatsApp to the owner. Only a real send proves the credentials and
  the template approval; the e2e proves the request is right, not that it
  arrives. Dry run without `--send`.
- **After a deploy** — `npm run smoke` reports `messaging=ok|fail` and names
  the failing checks.

**Watch:** a send path that logs a problem and RETURNS reads as success. The
reminder worker sets `sentAt` when the sender resolves, so a silent return marks
a message delivered that was never attempted — that is how three reminders for
one booking reported success while nothing arrived. Senders must throw.

**Watch:** the alerting channel and the checked channel are the same. If Twilio
is down, the WhatsApp alert about Twilio being down cannot arrive either. The
email alert is the backstop, which is why the owner-recipient check matters more
than it looks.

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 46 | "When people schedule bookings with me, I don't get notifications on either WhatsApp or email" — WhatsApp half. Nothing arrived after Aug 8; alerts had delivered and been read through Aug 8 00:12 UTC | The WhatsApp sender (a temporary Meta-provisioned "555" number from self-signup) lost its Meta registration around Aug 8: every send since fails in transit with Twilio error **63112**, while the Senders API still reports the sender ONLINE and the Messages API accepts each send as "queued". Nothing in code changed; the exact same template + sender that delivered on Aug 7 was reproduced failing on Aug 12. The monitor's own failure alerts rode the same dead channel (its email backstop goes to `DEFAULT_DESTINATION_EMAIL`, not necessarily a read inbox) | `smoke` "owner WhatsApp alerts are deliverable" — reads the newest outbound WhatsApp **delivery record** (crons send several a day, so it is a fresh canary) and fails on failed/undelivered. The registration itself must be fixed in Twilio Console → Messaging → Senders (re-register / re-verify the number) |
| 47 | Same report, email half: no email either, for any booking ever | There was no email channel on the owner booking alert at all — `alertHost` fanned out to WhatsApp + SMS only. With the WhatsApp sender dead (63112) and SMS failing 30034 (A2P 10DLC unregistered, known and off by default), the fan-out reached zero working channels | `test` `src/lib/booking/hostAlerts.test.ts` — email channel exists, sends to the resolved owner address, survives a Twilio channel throwing, and fails loudly (never silently) when no owner address resolves |

**Watch:** Twilio's Senders API said ONLINE for four days while Meta refused
every send with 63112. Sender status is an intention, not an outcome — only the
delivery record (`Messages` status `failed`/`undelivered`) tells the truth,
which is what the smoke check reads.

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 48 | "I was able to receive [the reminder] for email but not for WhatsApp" — the email reminder arrived, the WhatsApp one silently didn't | The `reminder_alert` template was approved by Meta under the **MARKETING** category (its "⏰ … Don't be late! 🗓️" wording reads promotional), and Meta throttles marketing templates per-recipient — error **63049, "Meta chose not to deliver"** — even though the template is approved and the send is accepted as queued. Booking alerts were unaffected because `booking_alert_v2` is UTILITY. Fixed by `reminder_utility_v2` ("Reminder about your upcoming appointment: {{1}} — see you then."), approved as UTILITY, wired via `TWILIO_REMINDER_CONTENT_SID` | `smoke` — the "owner WhatsApp alerts are deliverable" canary reads the newest outbound WhatsApp delivery record, and a 63049-dropped reminder is exactly what it fails on. Template wording rule: reminder/alert templates must read transactional (no urgency exclamations), or Meta will re-categorize them as marketing at approval time |

| # | Symptom | Cause | Guard |
|---|---|---|---|
| 50 | Monitor alerted "3 of 14 checks failing" (Availability 500, Database and reminders pool timeouts) with the site perfectly healthy minutes later | One Neon cold start (free tier suspends compute after idle) stalled the first query for seconds; with `connection_limit=1` every concurrent check queued behind it blew the pool's 10s timeout, and the availability request 500'd on the same cold DB. Three symptoms, one blip, zero real outage | `test` `src/lib/monitor/retry.test.ts` — the monitor now warms the DB first (retried `SELECT 1`), runs messaging checks off the concurrent path, and re-runs any failed check once: a healed blip reports ok (flap kept in the detail), a real outage fails both attempts and still alerts |

## Health

`GET /api/health` → `{"status":"ok","checks":{"database":"ok","api":"ok","agent":"ok"}}`,
200 when every subsystem is up and 503 otherwise. Public and unauthenticated so
monitors and the pre-push gate can poll it, and it reports only ok/fail per
subsystem — never a driver error, connection string, or key.

- `database` — a real query, so it proves the pool reaches Postgres rather than
  that Prisma merely loaded. This is what caught fire when the Neon compute
  quota ran out and the whole app 500'd.
- `api` — reaching the handler at all attests routing, the Node runtime and the
  proxy.
- `agent` — configuration only. It does **not** call the model: health is polled
  on every push and every call costs money. A missing key is the failure that
  actually happens.

Deliberately separate from `/api/cron/monitor`, which is the deep synthetic
check and **alerts over WhatsApp and email** — polling that on every push would
spam the owner.

## Known gaps

Honest list of what is **not** covered:

- Reminders, actionables and calendar writes have no live smoke coverage — they
  need an authenticated session.
- The mobile audit covers PUBLIC pages only. The authenticated dashboard (three
  panes, blocks agenda, reminder panel, event modals) is unchecked at phone
  viewports, and that is exactly where bug #17 was. Covering it needs an auth
  strategy for the test browser.
- The smoke checks are read-only by design: they never create a booking, so the
  write path is exercised only by unit tests.
- The double-booking race is guarded by a unique database index, not by a test.
- 8 pre-existing eslint errors are outstanding (see above); `npm run lint`.
- `tsc` reads `.next/types`, so stray `* 2.ts` duplicates left there by a
  file-sync tool surface as phantom "duplicate identifier" errors. Clear them
  with `find .next -name "* 2.*" -delete`.
