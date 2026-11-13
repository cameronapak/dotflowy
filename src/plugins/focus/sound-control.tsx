import {
  ArrowDown01Icon,
  AudioWave01Icon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  CloudLittleRainIcon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import {
  Button,
  buttonVariants,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTrigger,
} from "../kit";
import {
  playAmbience,
  SOUNDS,
  setAmbienceVolume,
  toggleAmbience,
  useAmbience,
  type SoundId,
} from "./ambience";

export const SOUND_ICON = {
  tick: Clock01Icon,
  rain: CloudLittleRainIcon,
  brown: AudioWave01Icon,
} satisfies Record<SoundId, typeof Clock01Icon>;
const labelOf = (id: SoundId) => SOUNDS.find((s) => s.id === id)!.label;

/** One press plays or pauses; the name says what will play. */
function PlayButton({ ghost, compact }: { ghost?: string; compact: boolean }) {
  const { sound, on } = useAmbience();
  return (
    <Button
      size={compact ? "icon-sm" : "sm"}
      variant="ghost"
      className={cn(ghost, on && "bg-primary-foreground/15")}
      aria-pressed={on}
      aria-label={on ? `Pause ${labelOf(sound)}` : `Play ${labelOf(sound)}`}
      title={on ? `Pause ${labelOf(sound)}` : `Play ${labelOf(sound)}`}
      onClick={toggleAmbience}
    >
      <HugeiconsIcon
        icon={on ? SOUND_ICON[sound] : VolumeOffIcon}
        data-icon={compact ? undefined : "inline-start"}
      />
      {!compact && <span className="max-sm:hidden">{labelOf(sound)}</span>}
    </Button>
  );
}

function VolumeSlider({ className }: { className?: string }) {
  const { volume } = useAmbience();
  return (
    <label className={cn("flex items-center gap-2", className)}>
      <HugeiconsIcon icon={VolumeHighIcon} className="size-4 opacity-70" />
      <span className="sr-only">Focus sound volume</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-current"
        onChange={(event) => setAmbienceVolume(Number(event.target.value))}
      />
    </label>
  );
}

/** The band: play/pause beside a chevron that opens the sound list and volume.
 * Choosing a sound plays it, so the list doubles as an audition. */
export function BandSoundControl({ ghost }: { ghost?: string }) {
  const { sound, on } = useAmbience();
  const [open, setOpen] = useState(false);
  return (
    <span className="flex items-center" data-testid="focus-sound">
      <PlayButton ghost={ghost} compact={false} />
      <ResponsivePopover title="Focus sound" open={open} onOpenChange={setOpen}>
        <ResponsivePopoverTrigger
          type="button"
          aria-label="Choose focus sound"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            ghost,
            "w-5",
          )}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} />
        </ResponsivePopoverTrigger>
        <ResponsivePopoverContent
          align="end"
          className="w-56 gap-1 p-1.5"
          aria-label="Focus sound"
        >
          {SOUNDS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={sound === option.id && on}
              className="flex h-9 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => playAmbience(option.id)}
            >
              <HugeiconsIcon icon={SOUND_ICON[option.id]} className="size-4" />
              <span className="flex-1">{option.label}</span>
              {sound === option.id && on && (
                <HugeiconsIcon
                  icon={CheckmarkCircle01Icon}
                  className="size-4 text-muted-foreground"
                />
              )}
            </button>
          ))}
          <VolumeSlider className="border-t px-2 pt-2 pb-1" />
        </ResponsivePopoverContent>
      </ResponsivePopover>
    </span>
  );
}

/** The floating window: a popover would open in the page, not the window, so
 * a native select switches sounds in place. In overtime, Done, +5 min, and Let
 * go fill the 300px footer, so only play/pause stays. */
export function CardSoundControl({
  ghost,
  playOnly = false,
}: {
  ghost?: string;
  playOnly?: boolean;
}) {
  const { sound } = useAmbience();
  if (playOnly) return <PlayButton ghost={ghost} compact />;
  return (
    <span className="flex items-center gap-0.5" data-testid="focus-sound">
      <PlayButton ghost={ghost} compact />
      <select
        aria-label="Focus sound"
        value={sound}
        className="h-7 max-w-[5.5rem] cursor-pointer truncate rounded-md bg-transparent px-1 text-xs hover:bg-primary-foreground/15 focus-visible:outline-2 focus-visible:outline-primary-foreground [&>option]:bg-background [&>option]:text-foreground"
        onChange={(event) => {
          const next = SOUNDS.find((s) => s.id === event.target.value);
          if (next) playAmbience(next.id);
        }}
      >
        {SOUNDS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
