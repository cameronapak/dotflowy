/** Return the canonical stored URL for explicit Embed text, or null. */
export function embedUrl(text: string): string | null {
  const trimmed = text.trim();
  const markdown = /^\[([^\]]*)\]\(([^()\s]+)\)$/.exec(trimmed);
  const candidate = markdown?.[2] ?? trimmed;
  if (!candidate || /\s/.test(candidate)) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
