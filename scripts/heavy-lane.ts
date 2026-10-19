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
    // Own the entire workload group, including shell/build descendants.
    detached: acquire,
  },
);

let signalExitCode: number | undefined;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    signalExitCode = code;
    if (!acquire) {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // The group can exit between receiving the signal and forwarding it.
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  });
}
const exitCode = await child.exited;
process.exit(signalExitCode ?? exitCode);
