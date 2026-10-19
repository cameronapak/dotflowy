import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapper = join(import.meta.dir, "heavy-lane.ts");

test.skipIf(process.platform !== "linux")(
  "Orb commands serialize across directories, allow nesting, and release after failure",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "dotflowy-heavy-test-"));
    const log = join(directory, "events");
    const env = {
      ...process.env,
      AMP_ORB: "1",
      DOTFLOWY_HEAVY_LANE: "",
      // Exercise the real lock without waiting behind another worktree's job.
      TMPDIR: directory,
      EVENTS: log,
      WRAPPER: wrapper,
    };
    const first = Bun.spawn(
      [
        "timeout",
        "8s",
        process.execPath,
        wrapper,
        process.execPath,
        "-e",
        `import { appendFileSync } from "node:fs";
         appendFileSync(process.env.EVENTS, "first:start\\n");
         const nested = Bun.spawn([process.execPath, process.env.WRAPPER,
           process.execPath, "-e",
           'require("node:fs").appendFileSync(process.env.EVENTS, "nested\\\\n")']);
         if (await nested.exited !== 0) process.exit(1);
         console.log("ready");
         await Bun.stdin.text();
         appendFileSync(process.env.EVENTS, "first:end\\n");`,
      ],
      { cwd: directory, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    let second: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const ready = first.stdout.getReader();
      expect(new TextDecoder().decode((await ready.read()).value)).toBe(
        "ready\n",
      );
      ready.releaseLock();
      const queued = Bun.spawn(
        [
          "timeout",
          "8s",
          process.execPath,
          wrapper,
          process.execPath,
          "-e",
          `require("node:fs").appendFileSync(process.env.EVENTS, "second\\n");
           console.log("started"); process.exit(7);`,
        ],
        { cwd: tmpdir(), env, stdout: "pipe", stderr: "inherit" },
      );
      second = queued;
      const started = new Response(queued.stdout).text();
      // Hold the first command while a separately launched command tries to run.
      expect(
        await Promise.race([
          started.then(() => "overlapped"),
          Bun.sleep(200).then(() => "blocked"),
        ]),
      ).toBe("blocked");
      first.stdin.end();
      expect(await first.exited).toBe(0);
      expect(await started).toBe("started\n");
      expect(await second.exited).toBe(7);
      expect(await readFile(log, "utf8")).toBe(
        "first:start\nnested\nfirst:end\nsecond\n",
      );
      const afterFailure = Bun.spawn(
        [
          "timeout",
          "3s",
          process.execPath,
          wrapper,
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        { env, stdout: "ignore", stderr: "inherit" },
      );
      expect(await afterFailure.exited).toBe(0);
      const outsideOrb = Bun.spawn(
        [process.execPath, wrapper, process.execPath, "-e", "process.exit(9)"],
        { env: { ...env, AMP_ORB: "" }, stdout: "ignore", stderr: "inherit" },
      );
      expect(await outsideOrb.exited).toBe(9);
    } finally {
      first.kill();
      second?.kill();
      await Promise.all([first.exited, second?.exited]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
