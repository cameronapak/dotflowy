import { describe, expect, test } from "bun:test";

import type { Release } from "./changelog";

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

describe("parseFragment", () => {
  test("reads the bump and the summary", () => {
    expect(parseFragment(fragment("minor", "Markdown paste."))).toEqual({
      bump: "minor",
      summary: "Markdown paste.",
    });
  });

  test("accepts an unquoted package name", () => {
    expect(parseFragment("---\ndotflowy: major\n---\n\nBreaking.\n")).toEqual({
      bump: "major",
      summary: "Breaking.",
    });
  });

  test("keeps a blank line -- a real paragraph break", () => {
    const parsed = parseFragment(fragment("patch", "One.\n\nTwo."));
    expect(parsed).toEqual({ bump: "patch", summary: "One.\n\nTwo." });
  });

  test("reflows a hard-wrapped paragraph -- a source wrap is not a line break", () => {
    const parsed = parseFragment(
      fragment("patch", "A summary wrapped\nat eighty columns\nby the editor."),
    );
    expect(parsed).toEqual({
      bump: "patch",
      summary: "A summary wrapped at eighty columns by the editor.",
    });
  });

  test("an empty changeset is null, not an error -- it is the chore: escape hatch", () => {
    expect(parseFragment(EMPTY_FRAGMENT)).toBeNull();
  });

  test("frontmatter that says something other than a bump is an error, not empty", () => {
    const parsed = parseFragment('---\n"dotflowy": huge\n---\n\nOops.\n');
    expect(parsed).toBeInstanceOf(Error);
  });

  test("a bump with no summary is an error", () => {
    expect(parseFragment('---\n"dotflowy": minor\n---\n\n')).toBeInstanceOf(
      Error,
    );
  });

  test("no frontmatter is an error", () => {
    expect(parseFragment("just prose\n")).toBeInstanceOf(Error);
  });
});

describe("buildReleases", () => {
  const ok = (r: Release[] | Error): Release[] => {
    if (r instanceof Error) throw r;
    return r;
  };

  test("reverses chronological input so releases[0] is the latest", () => {
    const releases = ok(
      buildReleases([
        {
          version: "0.1.0",
          date: "2026-06-19",
          fragments: [fragment("minor", "Alpha.")],
        },
        {
          version: "0.2.0",
          date: "2026-07-10",
          fragments: [fragment("minor", "Changelog.")],
        },
      ]),
    );
    expect(releases.map((r) => r.version)).toEqual(["0.2.0", "0.1.0"]);
  });

  test("sorts entries major -> minor -> patch within a release", () => {
    const releases = ok(
      buildReleases([
        {
          version: "1.0.0",
          date: "2026-07-10",
          fragments: [
            fragment("patch", "Fix."),
            fragment("major", "Relearn this."),
            fragment("minor", "New thing."),
          ],
        },
      ]),
    );
    expect(releases[0]!.entries.map((e) => e.bump)).toEqual([
      "major",
      "minor",
      "patch",
    ]);
  });

  test("empty changesets contribute no entries", () => {
    const releases = ok(
      buildReleases([
        {
          version: "0.2.0",
          date: "2026-07-10",
          fragments: [EMPTY_FRAGMENT, fragment("patch", "Real.")],
        },
      ]),
    );
    expect(releases[0]!.entries).toEqual([{ bump: "patch", summary: "Real." }]);
  });

  test("a release with no entries fails the build", () => {
    const r = buildReleases([
      { version: "0.2.0", date: "2026-07-10", fragments: [EMPTY_FRAGMENT] },
    ]);
    expect(r).toBeInstanceOf(Error);
  });

  test("a malformed fragment names its release", () => {
    const r = buildReleases([
      { version: "0.2.0", date: "2026-07-10", fragments: ["nope"] },
    ]);
    expect((r as Error).message).toContain("0.2.0");
  });

  test("rejects a non-semver version", () => {
    expect(
      buildReleases([
        {
          version: "v0.2",
          date: "2026-07-10",
          fragments: [fragment("patch", "x")],
        },
      ]),
    ).toBeInstanceOf(Error);
  });

  test("rejects a non-YYYY-MM-DD date", () => {
    expect(
      buildReleases([
        {
          version: "0.2.0",
          date: "July 10",
          fragments: [fragment("patch", "x")],
        },
      ]),
    ).toBeInstanceOf(Error);
  });

  test("rejects a duplicate version", () => {
    const one = {
      version: "0.2.0",
      date: "2026-07-10",
      fragments: [fragment("patch", "x")],
    };
    expect(buildReleases([one, one])).toBeInstanceOf(Error);
  });

  test("accepts a prerelease version", () => {
    expect(
      ok(
        buildReleases([
          {
            version: "1.0.0-rc.1",
            date: "2026-07-10",
            fragments: [fragment("patch", "x")],
          },
        ]),
      )[0]!.version,
    ).toBe("1.0.0-rc.1");
  });
});

describe("unseenCount", () => {
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

  test("counts the releases newer than the cursor", () => {
    expect(unseenCount(releases, "0.1.0")).toBe(2);
    expect(unseenCount(releases, "0.2.0")).toBe(1);
  });

  test("the latest version is nothing to show", () => {
    expect(unseenCount(releases, "0.3.0")).toBe(0);
  });

  test("a null cursor is nothing to show -- it means not-loaded/no-row, never unseen-everything", () => {
    expect(unseenCount(releases, null)).toBe(0);
  });

  test("an unknown cursor version stays quiet rather than crying wolf", () => {
    expect(unseenCount(releases, "9.9.9")).toBe(0);
  });
});

describe("hasBreaking", () => {
  test("true when any entry is a major bump", () => {
    expect(
      hasBreaking([
        {
          version: "1.0.0",
          date: "2026-07-10",
          entries: [{ bump: "major", summary: "x" }],
        },
      ]),
    ).toBe(true);
  });

  test("false otherwise", () => {
    expect(
      hasBreaking([
        {
          version: "0.2.0",
          date: "2026-07-10",
          entries: [
            { bump: "minor", summary: "x" },
            { bump: "patch", summary: "y" },
          ],
        },
      ]),
    ).toBe(false);
  });
});
