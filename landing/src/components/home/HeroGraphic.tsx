import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import {
  AppPage,
  NodeSwitcher,
  Row,
  Spoiler,
  TagChip,
} from "@/components/home/app-parts";
import { cn } from "@/lib/utils";

/* The homepage hero graphic, built from replicas of the app's own parts
 * (./app-parts) in HTML, not a screenshot: crisp at any DPR, theme-aware, and
 * real text.
 *
 * Everything inside a Stage is sized in `em`, and the Stage's font-size tracks
 * its own width (container query units), so each composition scales as one
 * object from phone to desktop. */

/** Pointer parallax: writes --mx/--my (-1..1) on the stage. Elements opt in
 * with `depth`. Off for reduced motion and for touch (no hover). */
function useParallax() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !matchMedia("(hover: hover)").matches
    )
      return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 2 - 1;
        const y = ((e.clientY - r.top) / r.height) * 2 - 1;
        el.style.setProperty("--mx", Math.max(-1, Math.min(1, x)).toFixed(3));
        el.style.setProperty("--my", Math.max(-1, Math.min(1, y)).toFixed(3));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);
  return ref;
}

function Stage({
  children,
  aspect,
  scale = 2.1,
  label,
}: {
  children: ReactNode;
  aspect: string;
  /** Font-size as a % of stage width. */
  scale?: number;
  label: string;
}) {
  const ref = useParallax();
  // The parallax vars start centered; useParallax rewrites them on the node.
  const style: CSSProperties & Record<"--mx" | "--my", number> = {
    aspectRatio: aspect,
    fontSize: `${scale}cqw`,
    "--mx": 0,
    "--my": 0,
  };
  return (
    <div className="@container w-full">
      <div
        ref={ref}
        role="img"
        aria-label={label}
        style={style}
        className="relative w-full select-none"
      >
        {children}
      </div>
    </div>
  );
}

/** A piece placed by % on the stage, lifted by `depth` (parallax + shadow). */
function Piece({
  x,
  y,
  rotate = 0,
  depth = 1,
  float,
  className,
  children,
}: {
  x: string;
  y: string;
  rotate?: number;
  depth?: number;
  /** Seconds of idle float delay; omit for still. */
  float?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden
      className="absolute"
      style={{
        left: x,
        top: y,
        transform: `translate(calc(var(--mx) * ${depth * 6}px), calc(var(--my) * ${depth * 6}px))`,
        transition: "transform 400ms cubic-bezier(0.23, 1, 0.32, 1)",
      }}
    >
      <div
        className={cn(
          float !== undefined &&
            "motion-safe:animate-[hero-float_6s_ease-in-out_infinite]",
          className,
        )}
        style={{
          rotate: `${rotate}deg`,
          animationDelay: float !== undefined ? `${float}s` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

const lift = (n: 1 | 2 | 3) =>
  [
    "",
    "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_20px_-6px_rgb(0_0_0/0.14)]",
    "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_18px_36px_-10px_rgb(0_0_0/0.2)]",
    "shadow-[0_2px_4px_rgb(0_0_0/0.06),0_30px_60px_-16px_rgb(0_0_0/0.28)]",
  ][n] +
  " dark:shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_24px_48px_-16px_rgb(0_0_0/0.6)]";

/* ── Parts not in the editor ─────────────────────────────────────────── */

function Keycap({
  children,
  wide,
  className,
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[2.6em] items-center justify-center rounded-[0.5em] border border-border bg-card text-[1em] font-medium text-foreground",
        "shadow-[inset_0_-0.18em_0_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.08),0_10px_20px_-8px_rgb(0_0_0/0.25)]",
        "dark:shadow-[inset_0_-0.18em_0_rgb(0_0_0/0.4),0_0_0_1px_rgb(255_255_255/0.06),0_10px_20px_-8px_rgb(0_0_0/0.6)]",
        wide ? "min-w-[3.6em] px-[0.8em]" : "w-[2.6em]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── B. Zoom stack ─────────────────────────────────────────────────────────
 * Nesting as depth: Home → Projects → Apartment move, left to right, each
 * zoom a card further along and closer to you. The breadcrumb is the path you just walked. */

export function HeroGraphic() {
  const card = (z: number) =>
    cn(
      "w-[30em] rounded-[0.9em] border border-border bg-card",
      z === 3 ? lift(3) : z === 2 ? lift(2) : lift(1),
    );
  return (
    <Stage
      aspect="10 / 8.2"
      scale={2.3}
      label="Three Dotflowy pages stacked in depth: Home, Projects, and Apartment move, showing zooming into a bullet"
    >
      <div
        className="absolute inset-0"
        style={{ perspective: "120em", perspectiveOrigin: "30% 20%" }}
      >
        <div
          className="absolute inset-0"
          style={{
            transform: "rotateX(14deg) rotateY(-16deg) rotateZ(3deg)",
            transformStyle: "preserve-3d",
          }}
        >
          <Piece x="0%" y="2%" depth={0.6}>
            <AppPage crumbs={[]} toolbar={false} className={card(1)}>
              <Row collapsed>Daily</Row>
              <Row collapsed accent>
                Projects
              </Row>
            </AppPage>
          </Piece>
          <Piece x="15%" y="22%" depth={1.4}>
            <AppPage
              crumbs={["Projects"]}
              toolbar={false}
              title="Projects"
              className={card(2)}
            >
              <Row collapsed accent>
                Apartment move <TagChip color="green">home</TagChip>
              </Row>
              <Row collapsed>
                Landing page <TagChip color="purple">work</TagChip>
              </Row>
              <Row collapsed>Taxes 2026</Row>
            </AppPage>
          </Piece>
          <Piece x="30%" y="45%" depth={2.4}>
            <AppPage
              crumbs={["Projects", "Apartment move #home"]}
              title={
                <>
                  Apartment move{" "}
                  <TagChip color="green" className="text-[0.75em]">
                    home
                  </TagChip>
                </>
              }
              className={card(3)}
            >
              <Row task="done">Give notice</Row>
              <Row task="open">
                Movers: get 3 quotes <TagChip color="red">urgent</TagChip>
              </Row>
              <Row agent>Grouped by room</Row>
              <Row depth={1}>Kitchen: 6 boxes, fragile</Row>
              <Row depth={1}>
                Lockbox code <Spoiler>||4417||</Spoiler>
              </Row>
            </AppPage>
          </Piece>
        </div>
      </div>

      {/* Floating in front of the stack, not on it. */}
      <Piece x="76%" y="4%" rotate={4} depth={3.4} float={0.4}>
        <div className={cn("flex items-center gap-[0.4em] text-[1.1em]")}>
          <Keycap>⌘</Keycap>
          <Keycap>K</Keycap>
        </div>
      </Piece>
      <Piece x="-4%" y="62%" rotate={-3} depth={3} float={1.5}>
        <NodeSwitcher
          query="apart"
          match="Apart"
          rest="ment move #home"
          path="Projects"
          className={cn("w-[15em]", lift(3))}
        />
      </Piece>
    </Stage>
  );
}
