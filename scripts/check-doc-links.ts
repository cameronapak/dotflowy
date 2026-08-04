#!/usr/bin/env bun
/**
 * Guards the pointer-based agent docs.
 *
 * AGENTS.md is deliberately thin: it states gotchas inline and points at
 * `docs/` + `docs/adr/` for everything else. A pointer at a file that does not
 * exist is worse than no pointer, because an agent reads the miss, shrugs, and
 * proceeds without the constraint it was meant to load.
 *
 * Checks every relative markdown link, and every "ADR NNNN" citation.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TARGETS = ["AGENTS.md", "README.md", "CONTRIBUTING.md", ...docsFiles()];

function docsFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else if (e.name.endsWith(".md")) out.push(next.replace(/^\.\//, ""));
    }
  };
  walk("docs");
  return out;
}

const adrNumbers = new Set(
  readdirSync(join(ROOT, "docs/adr"))
    .map((f) => f.match(/^(\d{4})-/)?.[1])
    .filter((n): n is string => Boolean(n)),
);

const failures: string[] = [];

for (const file of TARGETS) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, "utf8");
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;

    // Relative markdown links, ignoring anchors and external URLs.
    for (const m of line.matchAll(/\]\((\.\.?\/[^)#\s]+)/g)) {
      const target = resolve(dirname(abs), m[1]);
      if (!existsSync(target)) failures.push(`${at}  dead link -> ${m[1]}`);
    }

    // "ADR 0014" / "ADRs 0009, 0010" citations.
    for (const m of line.matchAll(/\bADRs?\s+((?:\d{4})(?:\s*,\s*\d{4})*)/g)) {
      for (const n of m[1].split(/\s*,\s*/)) {
        if (!adrNumbers.has(n)) failures.push(`${at}  no such ADR -> ${n}`);
      }
    }
  });
}

if (failures.length) {
  console.error(`\n${failures.length} dangling doc pointer(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Doc pointers OK (${TARGETS.length} files, ${adrNumbers.size} ADRs).`,
);
