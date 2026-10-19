import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// Root validation commands share one heavy-work lane across an Orb's worktrees.
// Outside an Orb, preserve normal local/CI parallelism. Nested commands inherit
// the lane instead of waiting for their own parent to release it.
const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("Usage: bun scripts/heavy-lane.ts <command> [args...]");
  process.exit(1);
}

const acquire = !!process.env.AMP_ORB && !process.env.DOTFLOWY_HEAVY_LANE;
if (acquire)
  console.error("[heavy lane] Waiting for shared build/test capacity");

const child = Bun.spawn(
  acquire
    ? [
        "flock",
        "--exclusive",
        "--no-fork",
        join(tmpdir(), `dotflowy-heavy-${process.getuid!()}.lock`),
        ...command,
      ]
    : command,
  {
    stdio: ["inherit", "inherit", "inherit"],
    env: acquire ? { ...process.env, DOTFLOWY_HEAVY_LANE: "1" } : process.env,
  },
);

let signalExitCode: number | undefined;
process.on("SIGINT", () => {
  signalExitCode = 130;
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  signalExitCode = 143;
  child.kill("SIGTERM");
});
const exitCode = await child.exited;
process.exit(signalExitCode ?? exitCode);
