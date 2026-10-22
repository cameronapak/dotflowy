import { Schema } from "effect";

const minutes = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 240 }),
);
export const focusSettingsSchema = Schema.Struct({
  focusMinutes: minutes,
  breakMinutes: minutes,
  longBreakMinutes: minutes,
  rounds: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 12 }),
  ),
  sounds: Schema.Boolean,
});
export type FocusSettings = Schema.Schema.Type<typeof focusSettingsSchema>;
export const DEFAULT_FOCUS_SETTINGS: FocusSettings = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  rounds: 4,
  sounds: true,
};
