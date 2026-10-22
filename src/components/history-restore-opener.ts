/** Shared progress signal for restore, structural paste, and Daily migration.
 * Kept independent of editor rendering so plugins can report progress without
 * importing the token registry back through the restore dialog. */
export type Stage =
  | { kind: "closed" }
  | { kind: "restoring"; label: string; total: number; applied: number };

let opener: ((stage: Stage) => void) | null = null;

export function setRestoreProgressOpener(fn: typeof opener): void {
  opener = fn;
}

export function setRestoreProgress(stage: Stage): void {
  opener?.(stage);
}
