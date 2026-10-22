#!/usr/bin/env bun
/**
 * Guards the pointer-based agent docs.
 *
 * AGENTS.md is deliberately thin: it states gotchas inline and points at
 * `docs/` + `docs/adr/` for everything else. A pointer at a file that does not
 * exist is worse than no pointer, because an agent reads the miss, shrugs, and
 * proceeds without the constraint it was meant to load.
 *
 * Four pointer shapes, all of which have broken in practice:
 *   1. relative markdown links          [x](./docs/y.md) and [x](docs/y.md)
 *   2. prose ADR citations              "ADR 0014", "ADRs 0009, 0010"
 *   3. bare ADR numbers in table cells  | Surface | 0009, 0010 |
 *   4. section citations from CODE      AGENTS.md "a node renders in ..."
 *
 * Shape 4 points the other way, out of the source tree and into the docs. It is
 * the one that broke when AGENTS.md was restructured, because a heading can be
 * renamed without ever opening the file that cites it.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Docs that must exist and carry content. A silent skip would pass an empty file. */
const REQUIRED = ["AGENTS.md", "README.md", "CONTRIBUTING.md"];

/** Source trees whose comments cite AGENTS.md sections by title. */
const CODE_DIRS = ["src", "worker", "e2e", "scripts"];
const CODE_EXT = /\.(ts|tsx|js|jsx)$/;

function walk(rel: string, keep: RegExp): string[] {
  const out: string[] = [];
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const next = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(next, keep));
    else if (keep.test(e.name)) out.push(next);
  }
  return out;
}

const docTargets = [...REQUIRED, ...walk("docs", /\.md$/)];
const codeTargets = CODE_DIRS.flatMap((d) => walk(d, CODE_EXT));

const adrNumbers = new Set(
  readdirSync(join(ROOT, "docs/adr"))
    .map((f) => f.match(/^(\d{4})-/)?.[1])
    .filter((n): n is string => Boolean(n)),
);

/** Headings and bold lead-ins of AGENTS.md, lowercased, for citation lookup. */
const agentsText = existsSync(join(ROOT, "AGENTS.md"))
  ? readFileSync(join(ROOT, "AGENTS.md"), "utf8").toLowerCase()
  : "";

const failures: string[] = [];

// A required doc that is missing or empty is a failure, not a skip.
for (const file of REQUIRED) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) failures.push(`${file}  required doc is missing`);
  else if (statSync(abs).size === 0)
    failures.push(`${file}  required doc is empty`);
}

for (const file of docTargets) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue;

  readFileSync(abs, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const at = `${file}:${i + 1}`;

      // 1. Relative markdown links, both `./x` and bare `x/y.md`.
      //    Skips absolute URLs, anchors, and prose placeholders like `[label](url)`
      //    that document link *syntax* rather than pointing anywhere.
      for (const m of line.matchAll(/\]\(([^)#\s]+)/g)) {
        const href = m[1];
        if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) continue;
        if (!href.includes("/") && !/\.[a-z0-9]+$/i.test(href)) continue;
        if (!existsSync(resolve(dirname(abs), href))) {
          failures.push(`${at}  dead link -> ${href}`);
        }
      }

      // 2. Prose citations: "ADR 0014", "ADRs 0009, 0010".
      for (const m of line.matchAll(
        /\bADRs?\s+((?:\d{4})(?:\s*,\s*\d{4})*)/g,
      )) {
        for (const n of m[1].split(/\s*,\s*/)) {
          if (!adrNumbers.has(n)) failures.push(`${at}  no such ADR -> ${n}`);
        }
      }

      // 3. Bare numbers in a table cell: `| Surface | 0009, 0010 |`.
      //    The densest pointer construct in AGENTS.md, and invisible to rule 2.
      const cells = line.match(/^\|(.+)\|\s*$/)?.[1].split("|") ?? [];
      for (const cell of cells) {
        if (!/^[\s\d,]*\d{4}[\s\d,]*$/.test(cell)) continue;
        for (const n of cell.match(/\d{4}/g) ?? []) {
          if (!adrNumbers.has(n)) failures.push(`${at}  no such ADR -> ${n}`);
        }
      }
    });
}

// 4. Section citations pointing from code INTO AGENTS.md: AGENTS.md "some heading".
//    A citation often wraps across comment lines, so each line is joined with the
//    two that follow before matching, and reported against the line it starts on.
const SELF = "scripts/check-doc-links.ts";
for (const file of codeTargets) {
  if (file.endsWith(SELF)) continue; // its own docs quote the pattern it looks for
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const flat = agentsText.replace(/\s+/g, " ");
  lines.forEach((line, i) => {
    // Both orders occur: `AGENTS.md "section"` and `the "section" section of AGENTS.md`.
    if (!/AGENTS\.md/.test(line) && !/"\s*$|"\s*section/.test(line)) return;
    const window = lines
      .slice(Math.max(0, i - 1), i + 3)
      .map((l) => l.replace(/^\s*\*\s?/, "")) // strip block-comment gutter
      .join(" ")
      .replace(/\s+/g, " ")
      .toLowerCase();
    const cites = [
      ...window.matchAll(/agents\.md\s*"([^"]{4,80})"/g),
      ...window.matchAll(/"([^"]{4,80})"\s*section of agents\.md/g),
    ];
    for (const m of cites) {
      const quoted = m[1].trim();
      if (!flat.includes(quoted)) {
        failures.push(
          `${file}:${i + 1}  no such AGENTS.md section -> "${quoted}"`,
        );
      }
    }
  });
}

const unique = [...new Set(failures)];

if (unique.length) {
  console.error(`\n${unique.length} dangling doc pointer(s):\n`);
  for (const f of unique) console.error(`  ${f}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Doc pointers OK (${docTargets.length} docs, ${codeTargets.length} source files, ${adrNumbers.size} ADRs).`,
);
