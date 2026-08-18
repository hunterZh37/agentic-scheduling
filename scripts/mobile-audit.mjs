#!/usr/bin/env node
// Mobile layout audit at real device viewports.
//
// Unlike scripts/smoke.mjs, this checks a property of the CODE, not of the
// deployment — so it runs against a LOCAL server by default and is meaningful
// before a push.
//
//   npm run audit:mobile                          # against http://localhost:3000
//   BASE=https://bookwithhunter.com npm run audit:mobile
//
// Read-only: it loads pages and measures them. It never submits anything.
//
// Exit 0 = clean, 1 = regression.
import { chromium, devices } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
// 320px (SE) is the one that catches fixed-width grids overflowing sideways.
const DEVICES = ["iPhone SE", "iPhone 13", "Pixel 7"];
const PAGES = ["/login", "/book", "/assistant", "/privacy", "/terms"];

// Overlays the page audit above can never reach: they only exist after an
// interaction. Every confirmation panel lived in this blind spot — a dialog can
// be wider than a 320px phone, or have buttons under the tap floor, and five
// clean page loads would still report "mobile clean".
//
// Each scenario opens one overlay on the dashboard and names the element to
// measure. Read-only: opening a dialog writes nothing, and the run never
// confirms one. Requires a local server with no PRIVATE_AUTH_SECRET (the
// dashboard is then ungated), which is how the pre-push hook starts it.
//
// `tab` switches the mobile pane first: on a phone the dashboard shows one pane
// at a time, so a control in the Blocks pane is display:none until its tab is
// selected. Without this every overlay but the first timed out — the audit
// looked like it was passing when it had simply never opened anything.
const CLICK_TIMEOUT = 8000;
const OVERLAYS = [
  {
    name: "calendars manager",
    open: (page) => page.getByRole("button", { name: "Manage", exact: true }).click({ timeout: CLICK_TIMEOUT }),
  },
  {
    // Inline card in the Blocks pane rather than a floating overlay, so it has
    // to be named explicitly — the "topmost fixed element" heuristic finds
    // nothing and would otherwise report it as a failure to open.
    name: "add item card",
    tab: "Schedule",
    open: (page) => page.getByRole("button", { name: "Add item" }).click({ timeout: CLICK_TIMEOUT }),
    expect: '[class*="addCard"]',
  },
  {
    name: "birthdays manager",
    open: (page) => page.getByRole("button", { name: /Birthdays/i }).first().click({ timeout: CLICK_TIMEOUT }),
  },
  {
    name: "reminders manager",
    open: (page) => page.getByRole("button", { name: /Reminders/i }).first().click({ timeout: CLICK_TIMEOUT }),
  },
  {
    name: "confirm dialog (delete a reserved block)",
    tab: "Schedule",
    open: (page) => page.locator('[aria-label^="Delete"]').first().click({ timeout: CLICK_TIMEOUT }),
    expect: '[role="alertdialog"]',
  },
  {
    name: "event detail modal",
    tab: "Schedule",
    open: (page) => page.locator('[class*="rowBodyOpen"]').first().click({ timeout: CLICK_TIMEOUT }),
  },
];

const MIN_INPUT_FONT = 16; // below this, iOS zooms on focus and never zooms back
const MIN_TAP = 44; // Apple HIG / WCAG 2.5.8 practical floor

// Controls deliberately allowed under the tap minimum, with the reason.
// WCAG 2.5.8 exempts links inside a sentence, and padding them out would wreck
// the line spacing of the legal prose.
const TAP_EXEMPT = [
  { match: (p, el) => (p === "/privacy" || p === "/terms") && el.startsWith("a"), why: "inline link in prose" },
];

const measure = (page) =>
  page.evaluate(
    ({ MIN_INPUT_FONT, MIN_TAP }) => {
      const vw = document.documentElement.clientWidth;
      const out = { vw, smallTaps: [], smallInputs: [], overflow: [] };
      out.docScrollWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0
      );
      out.horizontalScroll = out.docScrollWidth > vw + 1;

      const label = (el) => {
        const cls =
          typeof el.className === "string" && el.className
            ? "." + el.className.split(/\s+/)[0].replace(/^.*__/, "")
            : "";
        const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        return `${el.tagName.toLowerCase()}${cls}${t ? ` "${t.slice(0, 28)}"` : ""}`;
      };

      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 1 && el.children.length === 0) {
          out.overflow.push({ el: label(el), over: Math.round(r.right - vw) });
        }
      }

      const sel =
        "a[href], button, input, select, textarea, [role=button], [tabindex]:not([tabindex='-1'])";
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        // Height is the axis we can always control; width is often bounded by
        // the viewport (seven date columns on a 320px phone) or by the length
        // of the word itself.
        if (r.height < MIN_TAP) {
          out.smallTaps.push({ el: label(el), w: Math.round(r.width), h: Math.round(r.height) });
        }
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
          const type = (el.getAttribute("type") || "").toLowerCase();
          // Native date/time pickers are exempt by a documented decision in
          // globals.css: iOS does not zoom them, and forcing 16px widens the
          // control enough to overflow its container.
          const nativePicker = ["date", "time", "datetime-local", "month", "week"].includes(type);
          const fs = parseFloat(cs.fontSize);
          if (fs < MIN_INPUT_FONT && !nativePicker) {
            out.smallInputs.push({ el: label(el), fontSize: fs });
          }
        }
      }

      const vp = document.querySelector('meta[name="viewport"]')?.content ?? "";
      out.zoomBlocked = /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(vp);
      return out;
    },
    { MIN_INPUT_FONT, MIN_TAP }
  );

/// Measure an OPEN overlay: the dialog/sheet itself, not the page behind it.
/// Picks the topmost fixed-position element that covers the viewport, then
/// measures the panel inside it.
const measureOverlay = (page, expectSelector) =>
  page.evaluate(
    ({ MIN_INPUT_FONT, MIN_TAP, expectSelector }) => {
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;

      let overlay = expectSelector ? document.querySelector(expectSelector) : null;
      if (!overlay) {
        const fixed = [...document.querySelectorAll("body *")].filter((el) => {
          const cs = getComputedStyle(el);
          if (cs.position !== "fixed") return false;
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const r = el.getBoundingClientRect();
          return r.width >= vw * 0.5 && r.height >= vh * 0.3;
        });
        overlay = fixed[fixed.length - 1] ?? null;
      }
      if (!overlay) return { missing: true };

      // The panel is the overlay's own card, if it has one — the backdrop is
      // always viewport-sized and would never look too wide.
      const kids = [...overlay.children].filter((c) => c.getBoundingClientRect().width > 0);
      const panel = kids.length === 1 ? kids[0] : overlay;
      const pr = panel.getBoundingClientRect();

      const label = (el) => {
        const cls =
          typeof el.className === "string" && el.className
            ? "." + el.className.split(/\s+/)[0].replace(/^.*__/, "")
            : "";
        const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        return `${el.tagName.toLowerCase()}${cls}${t ? ` "${t.slice(0, 24)}"` : ""}`;
      };

      const out = {
        vw,
        vh,
        panelWidth: Math.round(pr.width),
        panelHeight: Math.round(pr.height),
        wider: pr.width > vw + 1,
        tallerThanViewport: pr.height > vh + 1,
        overflow: [],
        smallTaps: [],
        smallInputs: [],
      };

      // Can the user reach the bottom of a tall panel?
      const scrollable = [panel, overlay, ...overlay.querySelectorAll("*")].some((el) => {
        const cs = getComputedStyle(el);
        return (
          /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1
        );
      });
      out.scrollable = scrollable || panel.scrollHeight <= vh;

      for (const el of overlay.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 1 && el.children.length === 0) {
          out.overflow.push({ el: label(el), over: Math.round(r.right - vw) });
        }
      }

      const sel =
        "a[href], button, input, select, textarea, [role=button], [tabindex]:not([tabindex='-1'])";
      for (const el of overlay.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        // Links inside a rendered provider description (the event modal's `.desc`
        // block, dangerouslySetInnerHTML) are arbitrary PROSE content, not app
        // chrome — the same WCAG 2.5.8 exemption as an inline link in a sentence.
        // Forcing each to 44px would wreck the description's line spacing.
        if (el.closest('[class*="desc"]')) continue;
        // WCAG 2.5.8: a small checkbox is fine when its LABEL is the target,
        // since tapping the label toggles it. Measure the label in that case.
        const type = (el.getAttribute("type") || "").toLowerCase();
        const toggle = type === "checkbox" || type === "radio";
        const wrapping = toggle ? el.closest("label") : null;
        const effectiveH = wrapping ? wrapping.getBoundingClientRect().height : r.height;
        if (effectiveH < MIN_TAP) {
          out.smallTaps.push({ el: label(el), w: Math.round(r.width), h: Math.round(effectiveH) });
        }
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
          const nativePicker = ["date", "time", "datetime-local", "month", "week"].includes(type);
          // A checkbox/radio has nothing to type into, so iOS never zooms for
          // it — its font-size is irrelevant.
          const fs = parseFloat(cs.fontSize);
          if (fs < MIN_INPUT_FONT && !nativePicker && !toggle) {
            out.smallInputs.push({ el: label(el), fontSize: fs });
          }
        }
      }
      return out;
    },
    { MIN_INPUT_FONT, MIN_TAP, expectSelector: expectSelector ?? null }
  );

console.log(`\nMobile audit against ${BASE}`);
console.log(`  ${DEVICES.join(", ")}\n`);

const browser = await chromium.launch();
const problems = { overflow: [], inputs: [], taps: [], zoom: [], errors: [] };
let pagesChecked = 0;
let overlaysChecked = 0;

for (const dev of DEVICES) {
  const ctx = await browser.newContext({ ...devices[dev] });
  for (const path of PAGES) {
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 140)));
    page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 140)));
    try {
      await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(3000); // client-rendered content settles
    } catch (err) {
      problems.errors.push(`${dev} ${path}: ${String(err).slice(0, 100)}`);
      await page.close();
      continue;
    }
    const m = await measure(page);
    pagesChecked++;

    if (m.horizontalScroll) {
      problems.overflow.push(
        `${dev} ${path}: page is ${m.docScrollWidth}px wide in a ${m.vw}px viewport` +
          (m.overflow[0] ? ` (e.g. ${m.overflow[0].el} sticks out ${m.overflow[0].over}px)` : "")
      );
    }
    if (m.zoomBlocked) problems.zoom.push(`${dev} ${path}: viewport meta blocks pinch-zoom`);
    m.smallInputs.forEach((i) =>
      problems.inputs.push(`${dev} ${path}: ${i.el} is ${i.fontSize}px (iOS will zoom)`)
    );
    m.smallTaps.forEach((t) => {
      if (TAP_EXEMPT.some((e) => e.match(path, t.el))) return;
      problems.taps.push(`${dev} ${path}: ${t.el} is ${t.w}x${t.h}`);
    });
    consoleErrors.forEach((e) => problems.errors.push(`${dev} ${path}: ${e}`));
    await page.close();
  }

  // --- Overlays: dialogs, sheets and modals ---------------------------------
  // Measured within the overlay itself, so a pre-existing issue on the page
  // behind it cannot mask (or masquerade as) a problem in the panel.
  for (const scenario of OVERLAYS) {
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 140)));
    page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 140)));
    try {
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(3500);
      if (await page.locator('[href="/login"], form[action*="login"]').count()) {
        problems.errors.push(`${dev} overlays: dashboard is auth-gated; start the server without PRIVATE_AUTH_SECRET`);
        await page.close();
        break;
      }
      if (scenario.tab) {
        // role="tab", and the accessible name includes the icon glyph, so
        // match loosely rather than exactly.
        const tab = page.getByRole("tab", { name: new RegExp(scenario.tab, "i") });
        if (await tab.count()) await tab.first().click({ timeout: CLICK_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(400);
      }
      await scenario.open(page);
      await page.waitForTimeout(700);
    } catch (err) {
      problems.errors.push(`${dev} ${scenario.name}: could not open — ${String(err).split("\n")[0].slice(0, 90)}`);
      await page.close();
      continue;
    }

    const m = await measureOverlay(page, scenario.expect);
    if (m.missing) {
      problems.errors.push(`${dev} ${scenario.name}: opened but no overlay found to measure`);
      await page.close();
      continue;
    }
    overlaysChecked++;

    if (m.wider) {
      problems.overflow.push(
        `${dev} ${scenario.name}: panel is ${m.panelWidth}px in a ${m.vw}px viewport`
      );
    }
    if (m.tallerThanViewport && !m.scrollable) {
      problems.overflow.push(
        `${dev} ${scenario.name}: panel is ${m.panelHeight}px tall in a ${m.vh}px viewport and does not scroll — the buttons are unreachable`
      );
    }
    m.overflow.forEach((o) =>
      problems.overflow.push(`${dev} ${scenario.name}: ${o.el} sticks out ${o.over}px`)
    );
    m.smallInputs.forEach((i) =>
      problems.inputs.push(`${dev} ${scenario.name}: ${i.el} is ${i.fontSize}px (iOS will zoom)`)
    );
    m.smallTaps.forEach((t) =>
      problems.taps.push(`${dev} ${scenario.name}: ${t.el} is ${t.w}x${t.h}`)
    );
    consoleErrors.forEach((e) => problems.errors.push(`${dev} ${scenario.name}: ${e}`));
    await page.close();
  }

  await ctx.close();
}
await browser.close();

const section = (title, list, hint) => {
  if (!list.length) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${title}`);
    return 0;
  }
  console.log(`  \x1b[31mFAIL\x1b[0m  ${title}`);
  [...new Set(list)].slice(0, 12).forEach((l) => console.log(`          ${l}`));
  if (list.length > 12) console.log(`          ...and ${list.length - 12} more`);
  if (hint) console.log(`          \x1b[2m${hint}\x1b[0m`);
  return 1;
};

let failed = 0;
failed += section("no horizontal overflow", problems.overflow, "a fixed-width child is wider than the viewport");
failed += section("no input under 16px", problems.inputs, "iOS zooms in on focus and does not zoom back out");
failed += section("tap targets at least 44px tall", problems.taps, "44px is the floor for a reliable touch");
failed += section("pinch-zoom not blocked", problems.zoom);
failed += section("no console errors", problems.errors);

console.log(
  `\n  ${pagesChecked} page loads and ${overlaysChecked} overlays across ${DEVICES.length} devices`
);
console.log(failed ? `\n\x1b[31m${failed} check(s) failed\x1b[0m\n` : "\n\x1b[32mmobile clean\x1b[0m\n");
process.exit(failed ? 1 : 0);
