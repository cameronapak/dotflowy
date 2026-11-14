/** Where Find's results come from: every node, the current node only, or
 *  commands only. The rail and phone tabs pick one; Everywhere is the default. */
export type FindScope = "all" | "here" | "commands";

export interface FindRequest {
  query?: string;
  selection?: string;
  scope?: FindScope;
}

let opener: ((request?: FindRequest) => void) | null = null;

export function setNodeSwitcherOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the quick-switcher from anywhere (e.g. the header search button). */
export function openNodeSwitcher(request?: FindRequest) {
  opener?.(request);
}
