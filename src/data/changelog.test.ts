import { expect, test } from "bun:test";

import type { Bump, Release } from "./changelog";

import {
  buildReleases,
  hasBreaking,
  parseFragment,
  unseenCount,
} from "./changelog";

/** A changeset fragment as `changeset add` writes it. */
const fragment = (bump: string, summary: string) =>
  `---\n"dotflowy": ${bump}\n---\n\n${summary}\n`;

/** What `changeset add --empty` writes: frontmatter with no packages. */
const EMPTY_FRAGMENT = "---\n---\n";

test.each<[string, string, Bump, string]>([
  [
    "reads the bump and the summary",
    fragment("minor", "Markdown paste."),
    "minor",
    "Markdown paste.",
  ],
  [
    "accepts an unquoted package name",
    "---\ndotflowy: major\n---\n\nBreaking.\n",
    "major",
    "Breaking.",
  ],
  [
    "keeps a blank line, a real paragraph break",
    fragment("patch", "One.\n\nTwo."),
    "patch",
    "One.\n\nTwo.",
  ],
  [
    "reflows a hard-wrapped paragraph, a source wrap is not a line break",
    fragment("patch", "A summary wrapped\nat eighty columns\nby the editor."),
    "patch",
    "A summary wrapped at eighty columns by the editor.",
  ],
])("parseFragment %s", (_name, source, bump, summary) => {
  expect(parseFragment(source)).toEqual({ bump, summary });
});

test("parseFragment: an empty changeset is null (the chore: escape hatch); malformed ones are errors", () => {
  expect(parseFragment(EMPTY_FRAGMENT)).toBeNull();
  for (const source of [
    '---\n"dotflowy": huge\n---\n\nOops.\n', // not a bump
    '---\n"dotflowy": minor\n---\n\n', // no summary
    "just prose\n", // no frontmatter
  ]) {
    expect(parseFragment(source)).toBeInstanceOf(Error);
  }
});

const ok = (r: Release[] | Error): Release[] => {
  if (r instanceof Error) throw r;
  return r;
};

test("buildReleases puts the latest first, sorts entries by bump, and drops empty changesets", () => {
  const releases = ok(
    buildReleases([
      {
        version: "0.1.0",
        date: "2026-06-19",
        fragments: [fragment("minor", "Alpha.")],
      },
      {
        version: "1.0.0-rc.1",
        date: "2026-07-10",
        fragments: [
          fragment("patch", "Fix."),
          EMPTY_FRAGMENT,
          fragment("major", "Relearn this."),
          fragment("minor", "New thing."),
        ],
      },
    ]),
  );
  expect(releases.map((r) => r.version)).toEqual(["1.0.0-rc.1", "0.1.0"]);
  expect(releases[0]!.entries).toEqual([
    { bump: "major", summary: "Relearn this." },
    { bump: "minor", summary: "New thing." },
    { bump: "patch", summary: "Fix." },
  ]);
});

test.each([
  [
    "a release with no entries",
    [{ version: "0.2.0", date: "2026-07-10", fragments: [EMPTY_FRAGMENT] }],
  ],
  [
    "a non-semver version",
    [
      {
        version: "v0.2",
        date: "2026-07-10",
        fragments: [fragment("patch", "x")],
      },
    ],
  ],
  [
    "a non-YYYY-MM-DD date",
    [
      {
        version: "0.2.0",
        date: "July 10",
        fragments: [fragment("patch", "x")],
      },
    ],
  ],
  [
    "a duplicate version",
    [
      {
        version: "0.2.0",
        date: "2026-07-10",
        fragments: [fragment("patch", "x")],
      },
      {
        version: "0.2.0",
        date: "2026-07-11",
        fragments: [fragment("patch", "y")],
      },
    ],
  ],
])("buildReleases fails the build on %s", (_name, input) => {
  expect(buildReleases(input)).toBeInstanceOf(Error);
});

test("buildReleases names the release that holds a malformed fragment", () => {
  const r = buildReleases([
    { version: "0.2.0", date: "2026-07-10", fragments: ["nope"] },
  ]);
  expect(r).toBeInstanceOf(Error);
  // SAFETY: asserted to be an Error on the line above.
  expect((r as Error).message).toContain("0.2.0");
});

const releases: Release[] = [
  {
    version: "0.3.0",
    date: "2026-07-12",
    entries: [{ bump: "major", summary: "c" }],
  },
  {
    version: "0.2.0",
    date: "2026-07-11",
    entries: [{ bump: "minor", summary: "b" }],
  },
  {
    version: "0.1.0",
    date: "2026-07-10",
    entries: [{ bump: "patch", summary: "a" }],
  },
];

test.each([
  ["0.1.0", 2],
  ["0.2.0", 1],
  ["0.3.0", 0], // the latest version is nothing to show
  [null, 0], // not-loaded/no-row, never unseen-everything
  ["9.9.9", 0], // an unknown cursor stays quiet rather than crying wolf
] as const)("unseenCount with cursor %p is %p", (cursor, expected) => {
  expect(unseenCount(releases, cursor)).toBe(expected);
});

test("hasBreaking is true only when some entry is a major bump", () => {
  expect(hasBreaking(releases)).toBe(true);
  expect(hasBreaking(releases.slice(1))).toBe(false);
});
