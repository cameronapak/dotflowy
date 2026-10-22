import { Option, Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";

import {
  setFocusSettings,
  useEditorFeatures,
} from "../../data/editor-features";
import { focusSettingsSchema } from "../../data/focus-settings";
import { Button, Field, FieldGroup, FieldLabel, Input, Switch } from "../kit";
import { unlockSounds } from "./store";

export function FocusSettings() {
  const prefs = useEditorFeatures();
  const [saving, setSaving] = useState(false);
  return (
    <section
      aria-labelledby="focus-settings-title"
      className="flex flex-col gap-4"
    >
      <div>
        <h2 id="focus-settings-title" className="font-medium">
          Focus sessions
        </h2>
        <p className="text-sm text-muted-foreground">
          Pomodoro lengths and sounds. These settings follow your account.
        </p>
      </div>
      <form
        key={JSON.stringify(prefs.focus)}
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const decoded = Schema.decodeUnknownOption(focusSettingsSchema)({
            focusMinutes: Number(values.get("focusMinutes")),
            breakMinutes: Number(values.get("breakMinutes")),
            longBreakMinutes: Number(values.get("longBreakMinutes")),
            rounds: Number(values.get("rounds")),
            sounds: prefs.focus.sounds,
          });
          if (Option.isNone(decoded)) return;
          setSaving(true);
          void setFocusSettings(decoded.value)
            .catch(() =>
              toast.error(
                "Couldn't save focus settings. Your previous settings were restored.",
              ),
            )
            .finally(() => setSaving(false));
        }}
        className="flex flex-col gap-4"
      >
        <FieldGroup className="grid grid-cols-2 gap-4">
          {(
            [
              ["focusMinutes", "Focus minutes", 240],
              ["breakMinutes", "Break minutes", 240],
              ["longBreakMinutes", "Long break minutes", 240],
              ["rounds", "Rounds before a long break", 12],
            ] as const
          ).map(([key, label, max]) => (
            <Field key={key}>
              <FieldLabel htmlFor={`focus-${key}`}>{label}</FieldLabel>
              <Input
                id={`focus-${key}`}
                name={key}
                type="number"
                min={1}
                max={max}
                step={1}
                required
                defaultValue={prefs.focus[key]}
                disabled={!prefs.ready || saving}
              />
            </Field>
          ))}
        </FieldGroup>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={!prefs.ready || saving}
        >
          Save Pomodoro settings
        </Button>
      </form>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="focus-sounds">Sounds</FieldLabel>
        <Switch
          id="focus-sounds"
          checked={prefs.focus.sounds}
          disabled={!prefs.ready || saving}
          onCheckedChange={(sounds) => {
            setSaving(true);
            void setFocusSettings({ ...prefs.focus, sounds })
              .catch(() =>
                toast.error(
                  "Couldn't save sounds. Your previous setting was restored.",
                ),
              )
              .finally(() => setSaving(false));
            if (sounds) unlockSounds();
          }}
        />
      </Field>
    </section>
  );
}
