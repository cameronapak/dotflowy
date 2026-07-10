import { motion } from "motion/react";

import { useDailyNavigationPending } from "./pending";

/** Full-width indeterminate bar on the sticky header stack while daily get-or-create runs. */
export function DailyNavigationProgress() {
  const pending = useDailyNavigationPending();
  if (!pending) return null;

  return (
    <output
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 block h-0.5 overflow-hidden"
      aria-live="polite"
    >
      <span className="sr-only">Opening today&apos;s note…</span>
      <motion.div
        className="h-full w-1/4 bg-primary"
        animate={{ x: ["-100%", "400%"] }}
        transition={{
          repeat: Infinity,
          duration: 1.2,
          ease: "easeInOut",
        }}
      />
    </output>
  );
}
