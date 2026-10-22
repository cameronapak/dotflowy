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
import { startSession } from "./session";
import { unlockSounds, updateSession, useSession } from "./store";

const LAST_CHOICE = "dotflowy:focus-choice";
function lastChoice() {
  try {
    return localStorage.getItem(LAST_CHOICE) ?? "25";
  } catch {
    return "25";
  }
}

function FocusPicker({ id, ctx }: { id: string; ctx: PluginContext }) {
  const prefs = useEditorFeatures();
  const current = useSession();
  const oldNode = useNode(current?.sourceId ?? "");
  const node = useNode(trueSourceOf(ctx.tree, id));
  const [choice, setChoice] = useState(lastChoice);
  const [custom, setCustom] = useState(() =>
    choice.startsWith("custom:") ? choice.slice(7) : "30",
  );
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
          <DialogDescription>
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
            ctx.openOverlay(null);
          }}
        >
          <ToggleGroup
            aria-label="Session length"
            value={[isCustom ? "custom" : choice]}
            onValueChange={(values) => {
              if (values[0]) setChoice(values[0]);
            }}
            className="flex-wrap"
            variant="outline"
          >
            {["15", "25", "45", "60"].map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {value} min
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="pomodoro">Pomodoro</ToggleGroupItem>
            <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
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
          {choice === "pomodoro" && (
            <p className="text-sm text-muted-foreground">
              {prefs.focus.focusMinutes} min focus, {prefs.focus.breakMinutes}{" "}
              min break. {prefs.focus.longBreakMinutes} min break after{" "}
              {prefs.focus.rounds} rounds.
            </p>
          )}
          {current && current.phase !== "reflect" && (
            <p className="text-sm text-muted-foreground">
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
