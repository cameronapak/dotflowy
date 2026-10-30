import { Option, Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";

import {
  setFocusSettings,
  useEditorFeatures,
} from "../../data/editor-features";
import {
  focusSettingsSchema,
  type FocusSettings as Settings,
} from "../../data/focus-settings";
import { Input, SettingsOptionRow, SettingsSwitchTarget, Switch } from "../kit";
import { unlockSounds } from "./store";

const LENGTHS = [
  ["focusMinutes", "Focus minutes", 240, "min"],
  ["breakMinutes", "Break minutes", 240, "min"],
  ["longBreakMinutes", "Long break minutes", 240, "min"],
  ["rounds", "Rounds before a long break", 12, null],
] as const;

/** Focus sessions options in Settings (ADR 0074). Each value saves on its own
 *  when the field is left, like every other plugin option; an invalid entry
 *  restores the saved value instead of writing. */
export function FocusSettings() {
  const prefs = useEditorFeatures();
  const [saving, setSaving] = useState(false);
  const disabled = !prefs.ready || !prefs.focusSessions;
  const save = (next: Settings, label: string) => {
    setSaving(true);
    void setFocusSettings(next)
      .catch(() =>
        toast.error(
          `Couldn't save ${label}. Your previous setting was restored.`,
        ),
      )
      .finally(() => setSaving(false));
  };
  return (
    <>
      {LENGTHS.map(([key, label, max, unit]) => (
        <SettingsOptionRow key={key} title={label} htmlFor={`focus-${key}`}>
          <Input
            // Remount on a saved or restored value so the field shows it.
            key={prefs.focus[key]}
            id={`focus-${key}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            step={1}
            className="w-20 text-right tabular-nums"
            defaultValue={prefs.focus[key]}
            // Not disabled while saving: disabling the field Tab just moved to
            // would drop keyboard focus.
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              const input = event.currentTarget;
              const value = Number(input.value);
              if (input.value === "" || value === prefs.focus[key]) {
                input.value = String(prefs.focus[key]);
                return;
              }
              const decoded = Schema.decodeUnknownOption(focusSettingsSchema)({
                ...prefs.focus,
                [key]: value,
              });
              if (Option.isNone(decoded)) {
                input.value = String(prefs.focus[key]);
                toast.error(`Use a whole number from 1 to ${max}.`);
                return;
              }
              save(decoded.value, label.toLowerCase());
            }}
          />
          <span
            aria-hidden="true"
            className="w-7 text-sm text-muted-foreground"
          >
            {unit}
          </span>
        </SettingsOptionRow>
      ))}
      <SettingsOptionRow
        title="Sounds"
        description="Play a cue when time is up, a break ends, or you finish."
      >
        <SettingsSwitchTarget>
          <Switch
            aria-label="Sounds"
            checked={prefs.focus.sounds}
            disabled={disabled || saving}
            onCheckedChange={(sounds) => {
              save({ ...prefs.focus, sounds }, "sounds");
              if (sounds) unlockSounds();
            }}
          />
        </SettingsSwitchTarget>
      </SettingsOptionRow>
    </>
  );
}
