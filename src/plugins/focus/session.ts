import { Schema } from "effect";

import {
  focusSettingsSchema,
  type FocusSettings,
} from "../../data/focus-settings";

// Absolute deadlines survive throttling. runningSince measures only the current
// unpaused focus segment; focusMs holds finished segments, never break time.
export const sessionSchema = Schema.Struct({
  id: Schema.String,
  nodeId: Schema.String,
  sourceId: Schema.String,
  startedAt: Schema.Number,
  deadline: Schema.Number,
  duration: Schema.Number,
  focusMs: Schema.Number,
  runningSince: Schema.NullOr(Schema.Number),
  pausedAt: Schema.NullOr(Schema.Number),
  phase: Schema.Literals(["focus", "break", "ready", "reflect"]),
  round: Schema.Number,
  pomodoro: Schema.Boolean,
  notified: Schema.Boolean,
  settings: focusSettingsSchema,
});
export type FocusSession = Schema.Schema.Type<typeof sessionSchema>;

export function startSession(
  nodeId: string,
  sourceId: string,
  minutes: number,
  pomodoro: boolean,
  settings: FocusSettings,
  now: number,
): FocusSession {
  const duration = (pomodoro ? settings.focusMinutes : minutes) * 60_000;
  return {
    id: crypto.randomUUID(),
    nodeId,
    sourceId,
    startedAt: now,
    deadline: now + duration,
    duration,
    focusMs: 0,
    runningSince: now,
    pausedAt: null,
    phase: "focus",
    round: 1,
    pomodoro,
    notified: false,
    settings,
  };
}

export function focusTime(session: FocusSession, now: number): number {
  return (
    session.focusMs +
    (session.runningSince === null
      ? 0
      : Math.max(0, now - session.runningSince))
  );
}

export function remaining(session: FocusSession, now: number): number {
  return session.deadline - (session.pausedAt ?? now);
}

/** Ordinary sessions keep overtime; Pomodoro starts the break at the deadline,
 * even when a sleeping tab wakes much later. The next round is never automatic. */
export function advanceSession(
  session: FocusSession,
  now: number,
): FocusSession {
  if (session.pausedAt !== null || now < session.deadline) return session;
  if (session.phase === "focus" && session.pomodoro) {
    const duration =
      (session.round % session.settings.rounds === 0
        ? session.settings.longBreakMinutes
        : session.settings.breakMinutes) * 60_000;
    return advanceSession(
      {
        ...session,
        phase: "break",
        focusMs: focusTime(session, session.deadline),
        runningSince: null,
        deadline: session.deadline + duration,
        duration,
        notified: false,
      },
      now,
    );
  }
  if (session.phase === "break")
    return { ...session, phase: "ready", notified: true };
  if (session.phase === "focus" && !session.notified)
    return { ...session, notified: true };
  return session;
}

export function togglePause(session: FocusSession, now: number): FocusSession {
  // A click can land after the deadline but before the next clock tick.
  session = advanceSession(session, now);
  if (session.phase !== "focus" && session.phase !== "break") return session;
  if (session.pausedAt !== null)
    return {
      ...session,
      deadline: session.deadline + now - session.pausedAt,
      pausedAt: null,
      runningSince: session.phase === "focus" ? now : null,
    };
  return {
    ...session,
    focusMs: focusTime(session, now),
    runningSince: null,
    pausedAt: now,
  };
}

export function finishSession(
  session: FocusSession,
  now: number,
): FocusSession {
  return {
    ...session,
    phase: "reflect",
    focusMs: focusTime(session, now),
    runningSince: null,
    pausedAt: null,
  };
}

export function nextRound(session: FocusSession, now: number): FocusSession {
  if (session.phase !== "ready") return session;
  const duration = session.settings.focusMinutes * 60_000;
  return {
    ...session,
    phase: "focus",
    round: session.round + 1,
    duration,
    deadline: now + duration,
    runningSince: now,
    notified: false,
  };
}
