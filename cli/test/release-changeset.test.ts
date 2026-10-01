import { describe, expect, test } from "bun:test";

import {
  type CliPackageManifest,
  requiresCliChangeset,
} from "../scripts/require-changeset.js";

const manifest = {
  name: "dotflowy",
  version: "0.1.0",
  description: "Dotflowy CLI",
  license: "SEE LICENSE IN LICENSE",
  repository: { type: "git", url: "https://example.com/dotflowy.git" },
  bin: { dotflowy: "dist/main.js" },
  files: ["dist", "README.md", "LICENSE"],
  scripts: { build: "tsc", test: "bun test", prepack: "npm run build" },
  dependencies: { effect: "1.0.0" },
  devDependencies: { typescript: "1.0.0" },
  publishConfig: { access: "public" },
};

const changedManifest = (change: Partial<CliPackageManifest>) =>
  [["cli/package.json"], manifest, { ...manifest, ...change }] as const;

describe("CLI release boundary", () => {
  test.each(["cli/README.md", "cli/LICENSE", "cli/src/main.ts"])(
    "%s requires a CLI changeset",
    (path) => expect(requiresCliChangeset([path])).toBe(true),
  );

  test.each([
    ["description", { description: "New description" }],
    ["repository", { repository: { url: "https://example.com/new.git" } }],
    ["publishConfig", { publishConfig: { access: "restricted" } }],
    ["dependencies", { dependencies: { effect: "2.0.0" } }],
    [
      "install lifecycle script",
      { scripts: { ...manifest.scripts, postinstall: "node setup.js" } },
    ],
  ])("published %s metadata requires a CLI changeset", (_name, change) => {
    expect(requiresCliChangeset(...changedManifest(change))).toBe(true);
  });

  test("release-managed and development-only manifest fields do not require one", () => {
    const current = {
      ...manifest,
      version: "0.1.1",
      scripts: { ...manifest.scripts, test: "bun test test" },
      devDependencies: { typescript: "2.0.0" },
    };
    expect(requiresCliChangeset(["cli/package.json"], manifest, current)).toBe(
      false,
    );
  });

  test.each([
    "cli/test/process.test.ts",
    "cli/scripts/check-package.ts",
    "cli/CHANGELOG.md",
  ])("%s does not require a CLI changeset", (path) =>
    expect(requiresCliChangeset([path])).toBe(false),
  );
});
