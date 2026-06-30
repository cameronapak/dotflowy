let opener: ((sourceId: string) => void) | null = null;

export function setMirrorPlacesOpener(fn: typeof opener) {
  opener = fn;
}

/**
 * Open the "appears in N places" list for a mirrored node, from anywhere (the
 * mirror-count badge in a row or the zoomed title). Pass the SOURCE id (a row's
 * content id) -- {@link MirrorPlaces} normalizes a mirror id to its source.
 */
export function openMirrorPlaces(sourceId: string) {
  opener?.(sourceId);
}
