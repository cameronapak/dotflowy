import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

test("local launchers keep Wrangler URL and Origin on localhost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotflowy-cf-dev-"));
  try {
    for (const command of ["bun", "bunx"])
      await writeFile(
        join(directory, command),
        `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o755 },
      );
    const proc = Bun.spawn([process.execPath, "scripts/cf-dev.ts"], {
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
    const commands = output
      .split("\n")
      .filter((line) => line.startsWith('["'))
      .map((line) => JSON.parse(line));
    expect(commands).toContainEqual([
      "wrangler",
      "dev",
      "--port",
      "8787",
      "--local-upstream",
      "localhost:8787",
      "--upstream-protocol",
      "http",
      "--var",
      "SENTRY_DSN:",
    ]);
    const manifest = await Bun.file("package.json").json();
    expect(manifest.scripts["dev:api"]).toBe(
      "wrangler dev --port 8787 --local-upstream localhost:8787 --upstream-protocol http",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
