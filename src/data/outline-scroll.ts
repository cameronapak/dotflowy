/** The outline owns vertical scrolling; browser viewport panning stays native. */
export function getOutlineScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".outline-scroll");
}
