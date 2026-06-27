export const FAVICON_LIGHT = "/favicon-light.svg";
export const FAVICON_DARK = "/favicon-dark.svg";

export function faviconHref(resolved: "light" | "dark") {
  return resolved === "dark" ? FAVICON_DARK : FAVICON_LIGHT;
}

export function setFavicon(resolved: "light" | "dark") {
  const link =
    document.getElementById("dotflowy-favicon") ??
    document.querySelector('link[rel="icon"]');
  if (link instanceof HTMLLinkElement) {
    link.href = faviconHref(resolved);
  }
}
