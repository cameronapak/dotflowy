// The custom theme picker in Settings → Appearance (ADR 0088): drag a color
// across a field of dots (across is the color, up is how vivid), optionally
// add a second color, and set how much color fills the page. Everything else
// is derived in custom-theme.ts. Drags paint a draft; a release saves.
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";

import {
  formatCustomTheme,
  MAX_CHROMA,
  MIN_CHROMA,
  PALETTE_HUES,
  parseCustomTheme,
  seedColor,
  customThemeName,
  type CustomThemeSeed,
} from "../data/custom-theme";
import { MinusIcon, PlusIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import {
  commitColorThemeDraft,
  paintColorThemeDraft,
  setColorTheme,
  type ColorThemeId,
} from "./color-theme";
import { useTheme } from "./theme-provider";
import { Button } from "./ui/button";

type Dot = "first" | "second";

/** Arrow keys move a color: left and right turn the hue, up and down change
 *  how vivid it is. */
const ARROW_STEPS = new Map<string, readonly [number, number]>([
  ["ArrowLeft", [-6, 0]],
  ["ArrowRight", [6, 0]],
  ["ArrowUp", [0, 0.01]],
  ["ArrowDown", [0, -0.01]],
]);

const toPoint = (h: number, c: number) => ({
  x: h / 360,
  y: 1 - (c - MIN_CHROMA) / (MAX_CHROMA - MIN_CHROMA),
});
const fromPoint = (x: number, y: number) => ({
  h: Math.min(359.9, Math.max(0, x * 360)),
  c: MIN_CHROMA + (1 - Math.min(1, Math.max(0, y))) * (MAX_CHROMA - MIN_CHROMA),
});

function useDarkMode() {
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return theme === "dark" || (theme === "system" && systemDark);
}

export function CustomThemePicker({
  value,
  disabled,
}: {
  value: ColorThemeId;
  disabled: boolean;
}) {
  const seed = parseCustomTheme(value);
  const dark = useDarkMode();
  const field = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<Dot | null>(null);
  const [active, setActive] = useState<Dot>("first");
  const range = useRef<HTMLInputElement>(null);

  // The range's native change fires once the user lets go, however the drag
  // ends (pointer up off the track, a cancelled touch, or a key). React's
  // onChange is the input event, so it only paints.
  useEffect(() => {
    const el = range.current;
    el?.addEventListener("change", commitColorThemeDraft);
    return () => el?.removeEventListener("change", commitColorThemeDraft);
  }, [value]);

  // The field: one dot per spot, colored as it would look in this Mode.
  useEffect(() => {
    const el = canvas.current;
    const box = field.current;
    if (!el || !box) return;
    const draw = () => {
      const { width, height } = box.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      el.width = width * dpr;
      el.height = height * dpr;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.globalAlpha = 0.7;
      for (let y = 9; y < height; y += 14)
        for (let x = 9; x < width; x += 14) {
          const p = fromPoint(x / width, y / height);
          ctx.fillStyle = seedColor(p.h, p.c, dark);
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(box);
    return () => observer.disconnect();
  }, [dark]);

  if (!seed) return null;

  const draft = (next: CustomThemeSeed) =>
    paintColorThemeDraft(formatCustomTheme(next));
  const commit = (next: CustomThemeSeed) =>
    setColorTheme(formatCustomTheme(next));

  const seedAt = (event: PointerEvent, dot: Dot): CustomThemeSeed => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = fromPoint(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
    return dot === "second"
      ? { ...seed, second: point }
      : { ...seed, ...point };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const dot: Dot =
      seed.second &&
      event.target instanceof Element &&
      event.target.closest("[data-dot=second]")
        ? "second"
        : "first";
    dragging.current = dot;
    setActive(dot);
    event.currentTarget.setPointerCapture(event.pointerId);
    draft(seedAt(event, dot));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) draft(seedAt(event, dragging.current));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const dot = dragging.current;
    if (!dot) return;
    dragging.current = null;
    commit(seedAt(event, dot));
  };

  const fillStyle: CSSProperties & { "--fill": string } = {
    "--fill": `${Math.round(seed.tint * 100)}%`,
  };

  const nudge = (dot: Dot, key: string) => {
    const step = ARROW_STEPS.get(key);
    if (!step) return false;
    const current = dot === "second" && seed.second ? seed.second : seed;
    const moved = {
      h: (current.h + step[0] + 360) % 360,
      c: Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, current.c + step[1])),
    };
    // Paint each step; the key's release saves once (commitColorThemeDraft).
    draft(
      dot === "second" ? { ...seed, second: moved } : { ...seed, ...moved },
    );
    return true;
  };

  const handle = (dot: Dot, h: number, c: number) => {
    const p = toPoint(h, c);
    const name = customThemeName({ h, c, tint: 0 });
    return (
      <button
        key={dot}
        type="button"
        data-dot={dot}
        disabled={disabled}
        aria-label={`${dot === "first" ? "First" : "Second"} color, ${name}. Arrow keys change it.`}
        onFocus={() => setActive(dot)}
        onKeyDown={(e) => {
          if (nudge(dot, e.key)) e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (ARROW_STEPS.has(e.key)) commitColorThemeDraft();
        }}
        className={cn(
          "group/dot absolute -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full outline-none active:cursor-grabbing",
          active === dot ? "z-20" : "z-10",
        )}
        style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
      >
        <span
          className={cn(
            "block rounded-full transition-transform group-focus-visible/dot:outline-3 group-focus-visible/dot:outline-offset-8 group-focus-visible/dot:outline-ring/50 group-active/dot:scale-110",
            dot === "first" ? "size-[18px]" : "size-3",
          )}
          style={{
            background: seedColor(h, c, dark),
            boxShadow: `0 0 0 2px var(--muted), 0 0 0 ${dot === "first" ? 8 : 6}px color-mix(in srgb, ${seedColor(h, c, dark)} 28%, var(--muted)), 0 1px 3px rgb(0 0 0 / 0.25)`,
          }}
        />
        <span
          className={cn(
            "absolute left-1/2 -translate-x-1/2 rounded-md bg-popover px-2 py-px text-xs font-medium whitespace-nowrap text-popover-foreground shadow-sm ring-1 ring-border",
            p.y > 0.72 ? "bottom-[calc(100%+12px)]" : "top-[calc(100%+12px)]",
            active !== dot && "opacity-70",
          )}
        >
          {name}
        </span>
      </button>
    );
  };

  const activeDot = active === "second" && seed.second ? "second" : "first";
  const activeColor =
    activeDot === "second" && seed.second ? seed.second : seed;

  return (
    <div className="flex flex-col gap-2.5">
      <div
        ref={field}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn(
          "relative aspect-[16/10] touch-none overflow-hidden rounded-lg bg-muted select-none sm:aspect-[2/1]",
          disabled ? "opacity-60" : "cursor-crosshair",
        )}
      >
        <canvas
          ref={canvas}
          aria-hidden
          className="absolute inset-0 size-full"
        />
        {handle("first", seed.h, seed.c)}
        {seed.second && handle("second", seed.second.h, seed.second.c)}
      </div>
      <div className="flex items-center gap-2.5 max-sm:flex-col max-sm:items-start">
        <div
          role="group"
          aria-label="Palette colors"
          className="flex min-w-0 flex-1 flex-wrap gap-1.5"
        >
          {PALETTE_HUES.map((p) => (
            <button
              key={p.name}
              type="button"
              disabled={disabled}
              aria-label={p.name}
              aria-pressed={activeColor.h === p.h && activeColor.c === p.c}
              onClick={() => {
                const color = { h: p.h, c: p.c };
                commit(
                  activeDot === "second"
                    ? { ...seed, second: color }
                    : { ...seed, ...color },
                );
              }}
              className="size-[22px] shrink-0 rounded-full ring-1 ring-foreground/15 transition outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-2 aria-pressed:ring-offset-card"
              style={{ background: seedColor(p.h, p.c, dark) }}
            />
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => {
            if (seed.second) {
              setActive("first");
              commit({ h: seed.h, c: seed.c, tint: seed.tint });
              return;
            }
            // Start across the wheel, a little softer, so the pair reads as
            // two colors, and let the page show some of it.
            setActive("second");
            commit({
              ...seed,
              tint: Math.max(seed.tint, 0.45),
              second: {
                h: (seed.h + 150) % 360,
                c: Math.max(0.08, seed.c * 0.8),
              },
            });
          }}
        >
          {seed.second ? <MinusIcon /> : <PlusIcon />}
          Second color
        </Button>
      </div>
      <label className="flex items-center justify-between gap-3 pt-1 text-sm">
        <span className="font-medium">Page</span>
        <span className="flex w-56 items-center gap-2.5 text-xs text-muted-foreground max-sm:w-auto max-sm:flex-1">
          Paper
          <input
            type="range"
            min={0}
            max={100}
            disabled={disabled}
            aria-label="How much color fills the page"
            value={Math.round(seed.tint * 100)}
            onChange={(e) =>
              draft({ ...seed, tint: Number(e.currentTarget.value) / 100 })
            }
            ref={range}
            style={fillStyle}
            className="custom-theme-range min-w-0 flex-1"
          />
          Wash
        </span>
      </label>
    </div>
  );
}
