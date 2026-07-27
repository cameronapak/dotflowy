let opener: (() => void) | null = null;

export function setAddAgentOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the Add agent modal from anywhere (header, Cmd+K, presence chip). */
export function openAddAgent() {
  opener?.();
}
