/**
 * Dot mascot avatar (ADR 0059) — theme-aware SVG from Cam's light/dark assets.
 * Identity only; no face animation.
 */

type DotAvatarProps = {
  className?: string;
  title?: string;
  /** Provenance / chip hooks (e.g. `data-origin`). */
  "data-origin"?: string;
};

/** Light-mode fill/stroke; dark via `dark:` Tailwind on nested shapes. */
export function DotAvatar({
  className,
  title = "Dot",
  "data-origin": dataOrigin,
}: DotAvatarProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      data-origin={dataOrigin}
    >
      <circle
        cx="256"
        cy="256"
        r="256"
        className="fill-[#E2E2E2] dark:fill-[#2E2E2E]"
      />
      <path
        d="M237.009 356L325.555 267.454L237.009 178.908"
        className="stroke-[#535353] dark:stroke-[#BDBDBD]"
        strokeWidth="43.8165"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="146.5"
        cy="190.5"
        r="34.3976"
        className="fill-[#535353] stroke-[#535353] dark:fill-[#BDBDBD] dark:stroke-[#BDBDBD]"
        strokeWidth="0.204748"
      />
      <circle
        cx="366.5"
        cy="190.5"
        r="34.3976"
        className="fill-[#535353] stroke-[#535353] dark:fill-[#BDBDBD] dark:stroke-[#BDBDBD]"
        strokeWidth="0.204748"
      />
    </svg>
  );
}
