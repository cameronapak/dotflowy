import { expect, test } from "bun:test";

import { DEFAULT_FOCUS_SETTINGS } from "../../data/focus-settings";
import {
  advanceSession,
  finishSession,
  focusTime,
  nextRound,
  remaining,
  startSession,
  togglePause,
} from "./session";

test("pauses stop both the deadline and actual focus, while overtime still counts", () => {
  const start = startSession(
    "node",
    "source",
    15,
    false,
    DEFAULT_FOCUS_SETTINGS,
    10_000,
  );
  const paused = togglePause(start, 70_000);
  expect(remaining(paused, 370_000)).toBe(840_000);
  expect(focusTime(paused, 370_000)).toBe(60_000);
  const resumed = togglePause(paused, 370_000);
  const overdue = advanceSession(resumed, 1_270_000);
  expect(overdue.phase).toBe("focus");
  expect(remaining(overdue, 1_270_000)).toBe(-60_000);
  expect(finishSession(overdue, 1_270_000).focusMs).toBe(960_000);
});

test("Pomodoro catches up after sleep without counting breaks or starting another focus round", () => {
  const settings = {
    ...DEFAULT_FOCUS_SETTINGS,
    focusMinutes: 2,
    breakMinutes: 1,
    longBreakMinutes: 3,
    rounds: 2,
  };
  const start = startSession("node", "source", 0, true, settings, 0);
  const breaking = advanceSession(start, 150_000);
  expect(breaking.phase).toBe("break");
  expect(remaining(breaking, 150_000)).toBe(30_000);
  expect(focusTime(breaking, 150_000)).toBe(120_000);
  const pausedAfterDeadline = togglePause(start, 150_000);
  expect(pausedAfterDeadline.phase).toBe("break");
  expect(focusTime(pausedAfterDeadline, 600_000)).toBe(120_000);
  expect(remaining(pausedAfterDeadline, 600_000)).toBe(30_000);
  const waiting = advanceSession(breaking, 600_000);
  expect(waiting.phase).toBe("ready");
  expect(focusTime(waiting, 600_000)).toBe(120_000);
  const second = nextRound(waiting, 660_000);
  const longBreak = advanceSession(second, 780_000);
  expect(longBreak.phase).toBe("break");
  expect(remaining(longBreak, 780_000)).toBe(180_000);
  expect(finishSession(longBreak, 840_000).focusMs).toBe(240_000);
});
