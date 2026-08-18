<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# When the owner reports a bug

`docs/REGRESSIONS.md` is the ledger of every bug reported from real use of this
site. It exists because fixes here have repeatedly broken something else — most
sharply when a change that removed duplicate agenda rows left a reserved block
covering all bookable time, taking the booking page down completely.

A bug is not fixed until it is guarded. For every bug the owner reports:

1. **Reproduce it first.** Prove the cause with a failing test or a live request
   before changing code. Do not fix from a guess about the symptom.
2. **Add a row to the ledger** in the right section of `docs/REGRESSIONS.md`:
   the symptom in the owner's own words, the real root cause, and the guard.
3. **Add the guard.** A unit test when the logic is pure. A check in
   `scripts/smoke.mjs` when the failure comes from environment variables, the
   proxy matcher, or production data — unit tests structurally cannot catch
   those, and most outages here have been of exactly that kind. If neither is
   possible, mark it `manual` and say so; never imply coverage that isn't there.
4. **Run `npm run verify`** (tsc + unit tests + smoke) before pushing, and
   report the result honestly, failures included. A pre-push hook independently
   blocks pushes that fail typecheck or tests; never reach for
   `git push --no-verify` to get around a real failure.
5. **Re-run `npm run smoke` after the deploy is live.** It is read-only and
   safe against production. A green local run says nothing about whether the
   deployed environment is correct.

Update the ledger in the same commit as the fix. A row added later is a row
that never gets added.

# Checking production data

`DATABASE_URL` in `.env` points at a LOCAL database, not production. Querying it
tells you nothing about the live site — this has already produced one confidently
wrong answer about whether a record existed. To inspect real data, use the
deployed app or its API, not local Prisma.
