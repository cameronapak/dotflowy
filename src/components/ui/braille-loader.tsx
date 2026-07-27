"use client";

import * as React from "react";

import {
  type BrailleLoaderSpeed,
  type BrailleLoaderVariant,
  generateFrames,
  getVariantGridSize,
  normalizeVariant,
} from "@/lib/braille-loader";

type BrailleLoaderProps = React.ComponentProps<"div"> & {
  variant?: BrailleLoaderVariant;
  speed?: BrailleLoaderSpeed;
  label?: string;
  fontSize?: number;
};

const speedMultiplier: Record<BrailleLoaderSpeed, number> = {
  slow: 1.5,
  normal: 1,
  fast: 0.6,
};

function getPrefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    "matchMedia" in window &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(
    getPrefersReducedMotion,
  );

  React.useEffect(() => {
    if (!("matchMedia" in window)) return;

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  return prefersReducedMotion;
}

function BrailleLoader({
  variant = "breathe",
  speed = "normal",
  className,
  label = "Loading",
  fontSize = 28,
  style,
  ...props
}: BrailleLoaderProps) {
  const resolvedVariant = normalizeVariant(variant);
  const [width, height] = getVariantGridSize(resolvedVariant);
  const spanRef = React.useRef<HTMLSpanElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const framesData = React.useMemo(() => {
    return generateFrames(resolvedVariant, width, height);
  }, [resolvedVariant, width, height]);

  React.useEffect(() => {
    if (prefersReducedMotion || !spanRef.current) return;

    const frames = framesData.frames;
    let frameIndex = 0;
    const baseInterval = framesData.interval;
    const interval = baseInterval * speedMultiplier[speed];

    const updateFrame = () => {
      if (spanRef.current) {
        spanRef.current.textContent = frames[frameIndex] ?? "";
      }
      frameIndex = (frameIndex + 1) % frames.length;
    };

    updateFrame();
    const intervalId = setInterval(updateFrame, interval);

    return () => {
      clearInterval(intervalId);
    };
  }, [framesData, prefersReducedMotion, speed]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={["inline-flex items-center text-current", className]
        .filter(Boolean)
        .join(" ")}
      style={style}
      {...props}
    >
      <span className="sr-only">{label}</span>
      <span
        ref={spanRef}
        aria-hidden="true"
        style={{
          fontFamily: "monospace",
          whiteSpace: "pre",
          fontSize: `${fontSize}px`,
          lineHeight: 1,
          letterSpacing: 0,
        }}
      >
        {framesData.frames[0]}
      </span>
    </div>
  );
}

export { BrailleLoader, type BrailleLoaderProps };
