/**
 * Which changes can move the system diagram, and did they bring it along.
 *
 * Plain JavaScript with no imports at the top: the git hooks run it with
 * `node` before anything is built, and the test suite imports the same rules.
 *
 * It is deliberately coarse. It cannot tell whether a new file under src/lib
 * is a new component or a helper; it only says "this is the kind of change
 * that could redraw the picture, and the picture did not change". The author
 * decides; DIAGRAM_UNCHANGED=1 says "looked, nothing to draw".
 *
 * CLI:
 *   node tools/diagram-drift.mjs --staged        drift in the index (pre-commit)
 *   node tools/diagram-drift.mjs --commit <rev>  drift in one commit (post-commit)
 * Exit 0 = no drift, 1 = drift (reasons on stdout), 2 = could not tell.
 *
 * Spec: docs/superpowers/specs/2026-09-21-live-system-diagram-design.md
 * Origin: the same tool in the messaging-agent repo, with this repo's trees.
 */

export const DIAGRAM_JSON = "docs/diagrams/system-architecture.json";

/**
 * Source trees whose files are system pieces: adding, removing or renaming a
 * file here can add, remove or rename a box or an arrow. Editing one cannot.
 */
const STRUCTURAL = [
  /^src\/app\/api\//,
  /^src\/lib\//,
  /^src\/app\/[^/]+\/page\.tsx$/,
  /^calendly-extension\//,
  /^scripts\//,
];

/**
 * Files whose every edit is architectural: the auth gate decides which
 * surfaces are public, and vercel.json declares the cron processes.
 */
const ALWAYS = [/^vercel\.json$/, /^src\/proxy\.ts$/];

/** Never architectural, even inside a structural tree. */
const NEVER = [
  /(^|\/)tests?\//,
  /(^|\/)__fixtures__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.(css|scss|md|txt|png|jpe?g|svg|gif|webp|ico|snap|json)$/,
  /^docs\//,
  /^website\//,
  /^e2e\//,
  /^evals\//,
  /^public\//,
];

/** Files compared before and after rather than by status. */
const MANIFEST = "package.json";
const SCHEMA = "prisma/schema.prisma";

const matches = (rules, path) => rules.some((r) => r.test(path));

function depNames(text) {
  const pkg = JSON.parse(text || "{}");
  return new Set(Object.keys(pkg.dependencies || {}));
}

function modelNames(text) {
  const out = new Set();
  for (const m of (text || "").matchAll(/^model\s+(\w+)\s*\{/gm)) out.add(m[1]);
  return out;
}

function setDiff(before, after) {
  const added = [...after].filter((x) => !before.has(x)).map((x) => `+${x}`);
  const removed = [...before].filter((x) => !after.has(x)).map((x) => `-${x}`);
  return [...added, ...removed];
}

/**
 * @param {{status: string, path: string, from?: string}[]} entries
 *   `git diff --name-status -M` rows: status A/M/D/R…, path, and for a
 *   rename the old path in `from`.
 * @param {{manifests?: {before: string, after: string}, schema?: {before: string, after: string}}} [opts]
 *   File text before and after for package.json and prisma/schema.prisma,
 *   when they are part of the change.
 * @returns {{touched: boolean, reasons: string[]}}
 *   `touched`: the diagram JSON is part of the change. `reasons`: why the
 *   change could redraw the diagram; empty means it cannot.
 */
export function drift(entries, opts = {}) {
  const reasons = [];
  let touched = false;

  for (const e of entries) {
    const status = e.status[0];
    if (e.path === DIAGRAM_JSON) {
      // Deleting the source is not "bringing the diagram along": the guard
      // would otherwise be satisfied by removing the thing it guards.
      if (status === "D") reasons.push(`removed ${DIAGRAM_JSON}`);
      else touched = true;
      continue;
    }
    if (e.path === MANIFEST) {
      const m = opts.manifests;
      if (!m) continue;
      try {
        const diff = setDiff(depNames(m.before), depNames(m.after));
        if (diff.length) reasons.push(`package.json dependencies changed: ${diff.join(" ")}`);
      } catch {
        reasons.push("package.json changed (could not compare dependencies)");
      }
      continue;
    }
    if (e.path === SCHEMA) {
      const s = opts.schema;
      if (!s) continue;
      const diff = setDiff(modelNames(s.before), modelNames(s.after));
      if (diff.length) reasons.push(`prisma models changed: ${diff.join(" ")}`);
      continue;
    }
    if (matches(ALWAYS, e.path)) {
      reasons.push(`${status === "A" ? "added" : status === "D" ? "removed" : "edited"} ${e.path}`);
      continue;
    }
    if (matches(NEVER, e.path)) continue;
    if (!matches(STRUCTURAL, e.path) && !(e.from && matches(STRUCTURAL, e.from))) continue;
    if (status === "A") reasons.push(`added ${e.path}`);
    else if (status === "D") reasons.push(`removed ${e.path}`);
    else if (status === "R") reasons.push(`renamed ${e.from} -> ${e.path}`);
    else if (status === "C") reasons.push(`copied ${e.from} -> ${e.path}`);
    // M inside a structural tree: an edit, not a shape change.
  }
  return { touched, reasons };
}

// ---------------------------------------------------------------- CLI

function parseNameStatus(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (status.startsWith("R") || status.startsWith("C")) rows.push({ status, from: parts[1], path: parts[2] });
    else rows.push({ status, path: parts[1] });
  }
  return rows;
}

async function main(argv) {
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  // A root commit has no parent: `git show <rev>^:path` fails, and the
  // failure is expected, so keep its stderr out of the hook's output.
  const quiet = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const show = (rev, path) => {
    try {
      return quiet("show", `${rev}:${path}`);
    } catch {
      return "";
    }
  };
  let entries;
  let before;
  let after;
  if (argv[0] === "--staged") {
    entries = parseNameStatus(git("diff", "--cached", "--name-status", "-M"));
    before = (p) => show("HEAD", p);
    after = (p) => show(":", p);
  } else if (argv[0] === "--commit" && argv[1]) {
    entries = parseNameStatus(git("diff-tree", "-r", "-M", "--root", "--no-commit-id", "--name-status", argv[1]));
    before = (p) => show(`${argv[1]}^`, p);
    after = (p) => show(argv[1], p);
  } else {
    process.stderr.write("usage: diagram-drift.mjs --staged | --commit <rev>\n");
    return 2;
  }
  const opts = {};
  if (entries.some((e) => e.path === MANIFEST)) opts.manifests = { before: before(MANIFEST), after: after(MANIFEST) };
  if (entries.some((e) => e.path === SCHEMA)) opts.schema = { before: before(SCHEMA), after: after(SCHEMA) };
  const r = drift(entries, opts);
  if (r.touched || r.reasons.length === 0) return 0;
  process.stdout.write(r.reasons.join("\n") + "\n");
  return 1;
}

const isMain = typeof process !== "undefined" && process.argv[1] && /diagram-drift\.mjs$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`diagram-drift: ${err.message}\n`);
      process.exit(2);
    }
  );
}
