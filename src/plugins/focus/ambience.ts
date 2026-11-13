import { Option, Schema } from "effect";
import { useSyncExternalStore } from "react";

import { hasWindow } from "../../env";
import { remaining, type FocusSession } from "./session";
import { getSession, subscribeSession } from "./store";

/** Focus sounds (ADR 0074). Every sound is synthesized in the browser with
 * Web Audio into a short seamless loop, so nothing ships as an audio file and
 * nothing needs a license. Playback is owned by the tab that pressed play:
 * browsers only start audio from a user gesture, and two tabs playing the
 * same rain would double it. */
export const SOUNDS = [
  { id: "tick", label: "Clock tick" },
  { id: "rain", label: "Rain" },
  { id: "brown", label: "Brown noise" },
] as const;
export type SoundId = (typeof SOUNDS)[number]["id"];

const prefsSchema = Schema.Struct({
  sound: Schema.Literals(SOUNDS.map((s) => s.id)),
  volume: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** The picker's last choice: start this sound with the next session. */
  autoStart: Schema.Boolean,
});
type Prefs = Schema.Schema.Type<typeof prefsSchema>;
const PREFS_KEY = "dotflowy:focus-sound";
const DEFAULT_PREFS: Prefs = { sound: "rain", volume: 0.5, autoStart: false };

function loadPrefs(): Prefs {
  try {
    return Option.getOrElse(
      Schema.decodeUnknownOption(prefsSchema)(
        JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null"),
      ),
      () => DEFAULT_PREFS,
    );
  } catch {
    return DEFAULT_PREFS;
  }
}

interface State extends Prefs {
  /** This tab wants sound. Never true after a reload: autoplay needs a gesture. */
  on: boolean;
  /** Sound is coming out right now: on, and the session is in running focus. */
  audible: boolean;
}
let state: State = {
  ...(hasWindow() ? loadPrefs() : DEFAULT_PREFS),
  on: false,
  audible: false,
};
const listeners = new Set<() => void>();
function publish(next: Partial<State>) {
  state = { ...state, ...next };
  try {
    const { sound, volume, autoStart } = state;
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ sound, volume, autoStart }),
    );
  } catch {
    /* Sound still plays without storage; the choice just isn't remembered. */
  }
  for (const notify of listeners) notify();
}
export function subscribeAmbience(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}
export const getAmbience = () => state;
export function useAmbience() {
  return useSyncExternalStore(subscribeAmbience, getAmbience, () => state);
}

// --- Following the session ---------------------------------------------------

let unsubscribeSession: (() => void) | null = null;
let lastPhase: string | null = null;
let lastNotified = false;
let lastSessionId: string | null = null;

/** Sound plays only while focus time runs: it pauses with the session, rests
 * through breaks (and comes back for the next round), stops at time is up, and
 * stops for good when the session ends. */
function follow() {
  const session = getSession();
  let on = state.on;
  if (!session || session.phase === "reflect") on = false;
  // A replacement session, even one started in another tab with Sound Off,
  // ends this sound. playAmbience records the new ID first, so pressing play
  // for the replacement still starts it.
  else if (session.id !== lastSessionId) on = false;
  else if (
    lastPhase === "focus" &&
    !lastNotified &&
    session.phase === "focus" &&
    session.notified
  )
    // Time is up: the attention cue marks it, and silence keeps it marked.
    // Pressing play again carries the sound into overtime.
    on = false;
  lastSessionId = session?.id ?? null;
  lastPhase = session?.phase ?? null;
  lastNotified = session?.notified ?? false;
  const audible = on && session?.phase === "focus" && session.pausedAt === null;
  if (on !== state.on || audible !== state.audible) publish({ on, audible });
  engine.apply(audible ? state.sound : null, session);
  if (!on && unsubscribeSession) {
    unsubscribeSession();
    unsubscribeSession = null;
  }
}

// Another tab took over the sound, so this one goes quiet.
const channel =
  hasWindow() && "BroadcastChannel" in window
    ? new BroadcastChannel("dotflowy-focus-sound")
    : null;
if (channel)
  channel.onmessage = () => {
    if (state.on) {
      publish({ on: false });
      follow();
    }
  };

/** Call from a user gesture. Switching sounds while playing crossfades. */
export function playAmbience(sound: SoundId = state.sound) {
  engine.unlock();
  channel?.postMessage("claim");
  const session = getSession();
  lastSessionId = session?.id ?? null;
  lastPhase = session?.phase ?? null;
  lastNotified = session?.notified ?? false;
  publish({ sound, on: true });
  if (!unsubscribeSession) unsubscribeSession = subscribeSession(follow);
  follow();
}
export function pauseAmbience() {
  publish({ on: false });
  follow();
}
export function toggleAmbience() {
  if (state.on) pauseAmbience();
  else playAmbience();
}
export function setAmbienceVolume(volume: number) {
  publish({ volume });
  engine.volume(volume);
}
export function setAutoStart(sound: SoundId | null) {
  publish(sound ? { sound, autoStart: true } : { autoStart: false });
}

// --- Engine ------------------------------------------------------------------

// Perceived loudness differs a lot between a tick and a noise bed; these levels
// put every sound at about the same comfort at the same slider position.
const LEVEL = {
  tick: 0.9,
  rain: 0.55,
  brown: 0.6,
} satisfies Record<SoundId, number>;

const engine = (() => {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let current: {
    id: SoundId;
    source: AudioBufferSourceNode;
    gain: GainNode;
  } | null = null;
  let suspendTimer: number | null = null;
  const buffers = new Map<SoundId, AudioBuffer>();

  function context() {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: "playback" });
      master = ctx.createGain();
      master.gain.value = state.volume ** 2;
      master.connect(ctx.destination);
    }
    return ctx;
  }

  function fadeOut(node: NonNullable<typeof current>, seconds: number) {
    const c = context();
    node.gain.gain.cancelScheduledValues(c.currentTime);
    node.gain.gain.setValueAtTime(node.gain.gain.value, c.currentTime);
    node.gain.gain.linearRampToValueAtTime(0, c.currentTime + seconds);
    node.source.stop(c.currentTime + seconds + 0.05);
  }

  return {
    unlock() {
      const c = context();
      if (suspendTimer !== null) {
        window.clearTimeout(suspendTimer);
        suspendTimer = null;
      }
      void c.resume();
      // iOS Safari 17+: play through the silent switch, like a media app.
      // SAFETY: Audio Session is a WebKit API not yet in lib.dom; optional.
      const audioSession = (
        navigator as Navigator & { audioSession?: { type: string } }
      ).audioSession;
      if (audioSession) audioSession.type = "playback";
    },
    volume(volume: number) {
      if (!ctx || !master) return;
      master.gain.setTargetAtTime(volume ** 2, ctx.currentTime, 0.05);
    },
    apply(sound: SoundId | null, session: FocusSession | null) {
      if (!ctx && !sound) return;
      const c = context();
      if (current && current.id === sound) return;
      if (current) {
        fadeOut(current, sound ? 0.8 : 0.5);
        current = null;
      }
      if (!sound) {
        // Let the fade finish, then release the audio device.
        suspendTimer = window.setTimeout(() => {
          suspendTimer = null;
          if (!current) void c.suspend();
        }, 900);
        return;
      }
      if (suspendTimer !== null) {
        window.clearTimeout(suspendTimer);
        suspendTimer = null;
      }
      void c.resume();
      let buffer = buffers.get(sound);
      if (!buffer) {
        buffer = GENERATE[sound](c);
        buffers.set(sound, buffer);
      }
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = c.createGain();
      gain.gain.value = 0;
      // SAFETY: context() above created master alongside ctx.
      source.connect(gain).connect(master!);
      // The tick lands on the second the timer changes; noise starts anywhere
      // so every session doesn't open with the same few seconds.
      const offset =
        sound === "tick" && session
          ? ((1000 - (remaining(session, Date.now()) % 1000)) % 1000) / 1000
          : Math.random() * buffer.duration;
      source.start(0, offset);
      const fade = sound === "tick" ? 0.05 : 1.2;
      gain.gain.setValueAtTime(0, c.currentTime);
      gain.gain.linearRampToValueAtTime(LEVEL[sound], c.currentTime + fade);
      current = { id: sound, source, gain };
    },
  };
})();

// --- Synthesis ---------------------------------------------------------------

type Channels = Float32Array[];

/** A seamless loop: render a second past the end and fold it over the start
 * with an equal-power crossfade, so the seam has no click or level dip. */
function seamless(
  ctx: BaseAudioContext,
  seconds: number,
  render: (out: Channels, length: number, rate: number) => void,
  targetRms: number,
) {
  const rate = ctx.sampleRate;
  const length = Math.round(seconds * rate);
  const fade = rate;
  const raw: Channels = [
    new Float32Array(length + fade),
    new Float32Array(length + fade),
  ];
  render(raw, length + fade, rate);
  const buffer = ctx.createBuffer(2, length, rate);
  let sum = 0;
  for (let ch = 0; ch < 2; ch++) {
    const out = buffer.getChannelData(ch);
    const src = raw[ch]!;
    out.set(src.subarray(0, length));
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      out[i] = src[i]! * Math.sqrt(t) + src[length + i]! * Math.sqrt(1 - t);
    }
    for (let i = 0; i < length; i++) sum += out[i]! ** 2;
  }
  const scale = targetRms / Math.sqrt(sum / (2 * length) || 1);
  for (let ch = 0; ch < 2; ch++) {
    const out = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++)
      out[i] = Math.max(-1, Math.min(1, out[i]! * scale));
  }
  return buffer;
}

/** RBJ cookbook biquad, enough for the few filters these sounds need. */
function biquad(
  type: "lowpass" | "highpass" | "bandpass",
  freq: number,
  q: number,
  rate: number,
) {
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    a1 = 0,
    a2 = 0;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  const set = (f: number, qq: number) => {
    const w = (2 * Math.PI * f) / rate;
    const alpha = Math.sin(w) / (2 * qq);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    if (type === "lowpass") {
      b0 = (1 - cos) / 2 / a0;
      b1 = (1 - cos) / a0;
      b2 = b0;
    } else if (type === "highpass") {
      b0 = (1 + cos) / 2 / a0;
      b1 = -(1 + cos) / a0;
      b2 = b0;
    } else {
      b0 = alpha / a0;
      b1 = 0;
      b2 = -alpha / a0;
    }
    a1 = (-2 * cos) / a0;
    a2 = (1 - alpha) / a0;
  };
  set(freq, q);
  const run = (x: number) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
  return Object.assign(run, { set });
}

const white = () => Math.random() * 2 - 1;

function brown(ctx: BaseAudioContext) {
  return seamless(
    ctx,
    12,
    (out, n, rate) => {
      for (const data of out) {
        let last = 0;
        const lp = biquad("lowpass", 900, 0.7, rate);
        for (let i = 0; i < n; i++) {
          last = (last + 0.02 * white()) / 1.02;
          data[i] = lp(last);
        }
      }
    },
    0.14,
  );
}

function rain(ctx: BaseAudioContext) {
  return seamless(
    ctx,
    20,
    (out, n, rate) => {
      const wobble = Math.random() * Math.PI * 2;
      for (const [ch, data] of out.entries()) {
        // The bed: a steady hiss between 500 Hz and 6 kHz, with a slow swell.
        const hp = biquad("highpass", 500, 0.7, rate);
        const lp = biquad("lowpass", 6000, 0.7, rate);
        let rumble = 0;
        for (let i = 0; i < n; i++) {
          const t = i / rate;
          const swell = 0.85 + 0.15 * Math.sin(t * 0.9 + wobble + ch);
          rumble = (rumble + 0.02 * white()) / 1.02;
          data[i] = lp(hp(white())) * 0.35 * swell + rumble * 0.9;
        }
      }
      // Drops: many soft taps that blur into the hiss, and a few close
      // plinks: a rising bubble tone, which is what makes water read as water.
      const add = (at: number, sample: number, pan: number) => {
        if (at >= n) return;
        out[0]![at]! += sample * Math.sqrt(1 - pan);
        out[1]![at]! += sample * Math.sqrt(pan);
      };
      const meanGap = (perSecond: number) =>
        Math.max(1, Math.round((-Math.log(Math.random()) * rate) / perSecond));
      for (let t = 0; t < n; t += meanGap(90)) {
        const pan = Math.random();
        const amp = Math.exp(white() * 0.9) * 0.18;
        const bp = biquad("bandpass", 2500 + Math.random() * 4500, 2, rate);
        const len = Math.round(rate * 0.01);
        for (let i = 0; i < len; i++)
          add(t + i, bp(i === 0 ? 1 : 0) * amp * 8, pan);
      }
      for (let t = 0; t < n; t += meanGap(3)) {
        const pan = 0.2 + Math.random() * 0.6;
        const amp = 0.15 + Math.random() * 0.25;
        const from = 900 + Math.random() * 1400;
        const len = Math.round(rate * 0.05);
        let phase = 0;
        for (let i = 0; i < len; i++) {
          const time = i / rate;
          phase += (from * (1 + 1.2 * Math.min(1, time / 0.02))) / rate;
          add(
            t + i,
            Math.sin(2 * Math.PI * phase) * Math.exp(-time / 0.012) * amp,
            pan,
          );
        }
      }
    },
    0.12,
  );
}

/** One identical tick each second, not a tick-tock; the loop itself keeps
 * time, so a throttled or background tab never drifts. */
function tick(ctx: BaseAudioContext) {
  const rate = ctx.sampleRate;
  const length = rate;
  const buffer = ctx.createBuffer(2, length, rate);
  const data = buffer.getChannelData(0);
  const strike = (start: number, click: number, body: number) => {
    const bp = biquad("bandpass", click, 6, rate);
    const len = Math.round(rate * 0.06);
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const noise = bp(white()) * Math.exp(-t / 0.0025) * 2.2;
      const ring =
        Math.sin(2 * Math.PI * body * t) * Math.exp(-t / 0.012) * 0.35;
      const knock =
        Math.sin(2 * Math.PI * 420 * t) * Math.exp(-t / 0.008) * 0.25;
      data[start + i]! += noise + ring + knock;
    }
  };
  strike(0, 3800, 1900);
  let peak = 0;
  for (const s of data) peak = Math.max(peak, Math.abs(s));
  for (let i = 0; i < length; i++) data[i] = (data[i]! / peak) * 0.5;
  buffer.getChannelData(1).set(data);
  return buffer;
}

const GENERATE = {
  tick,
  rain,
  brown,
} satisfies Record<SoundId, (ctx: BaseAudioContext) => AudioBuffer>;
