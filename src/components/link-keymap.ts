import { linkUrlAtOffset } from "../data/links";
import { getCaretOffset, readSource } from "./inline-code";

export function openLinkAtCaret(el: HTMLElement): boolean {
  const url = linkUrlAtOffset(readSource(el), getCaretOffset(el));
  if (!url) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
