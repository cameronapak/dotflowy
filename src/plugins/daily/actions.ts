import type { GlobalActionSpec } from "../types";

import {
  EMPTY_DAYS_MODES,
  peekEditorFeatures,
  setDailyToggle,
  setEmptyDaysMode,
  setWeekStart,
  type DailyToggle,
} from "../../data/editor-features";
import {
  featureToggleAction,
  FeatureSettingsIcon,
  savePluginPreference,
} from "../feature-actions";

/** Settings remain reachable while Daily's editor seams are disabled. */
export function dailyGlobalActions(): GlobalActionSpec[] {
  const prefs = peekEditorFeatures();
  const toggles: { key: DailyToggle; label: string; description: string }[] = [
    {
      key: "dayStream",
      label: "Day stream",
      description: "Scroll from one day to the next",
    },
    {
      key: "weekStrip",
      label: "Week strip",
      description: "Show the week's days above a daily note",
    },
  ];
  return [
    featureToggleAction("daily", "Daily notes"),
    ...toggles.map(({ key, label, description }) => ({
      id: key,
      label: `Turn ${prefs[key] ? "off" : "on"} ${label}`,
      description,
      icon: FeatureSettingsIcon,
      keywords: ["daily", "settings", "calendar"],
      disabled: !prefs.ready || !prefs.daily,
      run: () =>
        savePluginPreference(() =>
          setDailyToggle(key, !peekEditorFeatures()[key]),
        ),
    })),
    ...EMPTY_DAYS_MODES.map((mode) => ({
      id: `empty-days:${mode}`,
      label: `Empty days: ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
      description:
        prefs.emptyDays === mode
          ? "Current Empty days setting"
          : "Choose how the Day stream presents Empty days",
      icon: FeatureSettingsIcon,
      keywords: ["daily", "settings", "stream", "empty", mode],
      disabled: !prefs.ready || !prefs.daily || !prefs.dayStream,
      run: () => savePluginPreference(() => setEmptyDaysMode(mode)),
    })),
    ...(["sunday", "monday"] as const).map((day) => ({
      id: `week-start:${day}`,
      label: `Week starts on: ${day === "sunday" ? "Sunday" : "Monday"}`,
      description:
        prefs.weekStart === day
          ? "Current Week start"
          : "Change your Daily calendar and reorganize its weeks",
      icon: FeatureSettingsIcon,
      keywords: ["daily", "settings", "calendar", "week", day],
      disabled: !prefs.ready || prefs.weekStartSaving,
      run: () => savePluginPreference(() => setWeekStart(day)),
    })),
  ];
}
