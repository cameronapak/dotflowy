import process from "node:process";

const projects = [
  "tsconfig.json",
  "worker/tsconfig.json",
  "tsconfig.test.json",
  "cli/tsconfig.test.json",
];
const format =
  process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "text";
let failed = false;

for (const project of projects) {
  console.log(`[effect] ${project}`);
  const check = Bun.spawn(
    [
      "bunx",
      "--package",
      "@effect/tsgo@0.70.0",
      "effect-tsgo",
      "diagnostics",
      "--project",
      project,
      "--format",
      format,
      "--severity",
      "error",
      "--lspconfig",
      JSON.stringify({ name: "@effect/language-service", diagnostics: true }),
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if ((await check.exited) !== 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
