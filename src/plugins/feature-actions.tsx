import { Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import type { GlobalActionSpec } from "./types";

import {
  peekEditorFeatures,
  setEditorFeature,
  type EditorFeature,
} from "../data/editor-features";

export function FeatureSettingsIcon({ className }: { className?: string }) {
  return <HugeiconsIcon icon={Settings02Icon} className={className} />;
}

/** Reuse the account preference write/rollback path, never optional seams. */
export function featureToggleAction(
  feature: EditorFeature,
  label: string,
): GlobalActionSpec {
  const prefs = peekEditorFeatures();
  return {
    id: "enabled",
    label: `Turn ${prefs[feature] ? "off" : "on"} ${label}`,
    description:
      "Change this account-wide editor feature without changing your notes",
    icon: FeatureSettingsIcon,
    keywords: ["settings", "plugin", "feature", "enable", "disable", feature],
    disabled: !prefs.ready,
    run: () =>
      savePluginPreference(() =>
        setEditorFeature(feature, !peekEditorFeatures()[feature]),
      ),
  };
}

export function savePluginPreference(save: () => Promise<void>) {
  void save().catch(() =>
    toast.error("Couldn't save this setting. Try again."),
  );
}
