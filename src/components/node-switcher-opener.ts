export interface FindRequest {
  query?: string;
  selection?: string;
}

let opener: ((request?: FindRequest) => void) | null = null;

export function setNodeSwitcherOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the quick-switcher from anywhere (e.g. the header search button). */
export function openNodeSwitcher(request?: FindRequest) {
  opener?.(request);
}
