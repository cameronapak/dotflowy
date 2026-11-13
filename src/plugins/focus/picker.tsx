import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import type { PluginContext } from "../types";

import { useEditorFeatures } from "../../data/editor-features";
import { flattenInline } from "../../data/inline-text";
import { redactSpoilers } from "../../data/spoiler";
import { trueSourceOf } from "../../data/tree";
import { useNode } from "../../data/tree-store";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  ToggleGroup,
  ToggleGroupItem,
} from "../kit";
import {
  getAmbience,
  pauseAmbience,
  playAmbience,
  setAutoStart,
  SOUNDS,
  type SoundId,
} from "./ambience";
import { startSession } from "./session";
import { SOUND_ICON } from "./sound-control";
import { unlockSounds, updateSession, useSession } from "./store";

const LAST_CHOICE = "dotflowy:focus-choice";
function lastChoice() {
  try {
    return localStorage.getItem(LAST_CHOICE) ?? "25";
  } catch {
    return "25";
  }
}

// The selected length takes the primary fill so it never reads like a hover.
const CHOICE =
  "h-10 min-w-0 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90";

function FocusPicker({ id, ctx }: { id: string; ctx: PluginContext }) {
  const prefs = useEditorFeatures();
  const current = useSession();
  const oldNode = useNode(current?.sourceId ?? "");
  const node = useNode(trueSourceOf(ctx.tree, id));
  const [choice, setChoice] = useState(lastChoice);
  const [custom, setCustom] = useState(() =>
    choice.startsWith("custom:") ? choice.slice(7) : "30",
  );
  const [sound, setSound] = useState<SoundId | "off">(() => {
    const prefs = getAmbience();
    return prefs.autoStart ? prefs.sound : "off";
  });
  const isCustom = choice.startsWith("custom");
  const minutes = Number(isCustom ? custom : choice);
  const valid =
    choice === "pomodoro" ||
    (Number.isFinite(minutes) && minutes > 0 && minutes <= 1440);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) ctx.openOverlay(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Focus session</DialogTitle>
          {/* Node text is unbounded; a bare URL must wrap, not widen the dialog. */}
          <DialogDescription className="wrap-anywhere">
            {flattenInline(redactSpoilers(node?.text ?? "Untitled"))}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || !node || !prefs.ready) return;
            if (prefs.focus.sounds) unlockSounds();
            const remembered = isCustom ? `custom:${custom}` : choice;
            try {
              localStorage.setItem(LAST_CHOICE, remembered);
            } catch {
              /* The picker remains usable without storage. */
            }
            updateSession(() =>
              startSession(
                id,
                node.id,
                minutes,
                choice === "pomodoro",
                prefs.focus,
                Date.now(),
              ),
            );
            // The submit is the gesture that lets the sound start.
            setAutoStart(sound === "off" ? null : sound);
            if (sound !== "off") playAmbience(sound);
            else if (getAmbience().on) pauseAmbience();
            ctx.openOverlay(null);
          }}
        >
          <ToggleGroup
            aria-label="Session length"
            value={[isCustom ? "custom" : choice]}
            onValueChange={(values) => {
              if (values[0]) setChoice(values[0]);
            }}
            className="grid w-full grid-cols-4"
            variant="outline"
          >
            {["15", "25", "45", "60"].map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className={`${CHOICE} h-16 flex-col gap-0`}
              >
                <span className="text-xl font-semibold tabular-nums">
                  {value}
                </span>{" "}
                <span className="text-xs opacity-70">min</span>
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem
              value="pomodoro"
              className={`${CHOICE} col-span-2`}
            >
              Pomodoro
            </ToggleGroupItem>
            <ToggleGroupItem value="custom" className={`${CHOICE} col-span-2`}>
              Custom
            </ToggleGroupItem>
          </ToggleGroup>
          {isCustom && (
            <Field>
              <FieldLabel htmlFor="focus-custom">Minutes</FieldLabel>
              <Input
                id="focus-custom"
                type="number"
                min="0.01"
                max="1440"
                step="any"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            </Field>
          )}
          <Field>
            <FieldLabel id="focus-sound-label">Sound</FieldLabel>
            <ToggleGroup
              aria-labelledby="focus-sound-label"
              value={[sound]}
              onValueChange={(values) => {
                if (values[0])
                  setSound(SOUNDS.find((s) => s.id === values[0])?.id ?? "off");
              }}
              className="grid w-full grid-cols-4 items-stretch"
              variant="outline"
            >
              <ToggleGroupItem
                value="off"
                className={`${CHOICE} h-auto min-h-14`}
              >
                Off
              </ToggleGroupItem>
              {SOUNDS.map((option) => (
                // On a phone the four columns are narrower than "Brown noise",
                // so a label wraps to two lines inside its tile.
                <ToggleGroupItem
                  key={option.id}
                  value={option.id}
                  className={`${CHOICE} h-auto min-h-14 flex-col gap-1 px-1 py-2 text-center text-xs leading-tight whitespace-normal`}
                >
                  <HugeiconsIcon icon={SOUND_ICON[option.id]} />
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          {choice === "pomodoro" && (
            <p className="text-sm text-muted-foreground">
              {prefs.focus.focusMinutes} min focus, {prefs.focus.breakMinutes}{" "}
              min break. {prefs.focus.longBreakMinutes} min break after{" "}
              {prefs.focus.rounds}{" "}
              {prefs.focus.rounds === 1 ? "round" : "rounds"}.
            </p>
          )}
          {current && current.phase !== "reflect" && (
            <p className="text-sm wrap-anywhere text-muted-foreground">
              Replaces:{" "}
              {flattenInline(redactSpoilers(oldNode?.text ?? "Untitled"))}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!valid || !node || !prefs.ready}>
              Start focus session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function openFocusPicker(id: string, ctx: PluginContext) {
  ctx.openOverlay(<FocusPicker id={id} ctx={ctx} />);
}
