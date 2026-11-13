// The share target's client half (ADR 0085). `POST /share` moves the shared
// fields into the /share page's URL fragment; this module reads them, keeps
// them across a sign-in round trip, and turns them into one capture.

const STORAGE_KEY = "dotflowy:share";

/** What arrived from the share sheet, or why it could not be read. The
 *  attempt ID is minted once per share, so every retry of Add to Today
 *  replays the same capture instead of adding it twice. */
export type SharePayload =
  | { attemptId: string; title?: string; text?: string; url?: string }
  | { error: "rejected" | "invalid" };

/** Move a fresh `#title=…&text=…&url=…` (or `#error=…`) fragment into this
 *  tab's sessionStorage and drop it from the address bar, so the shared text
 *  survives sign-in (same tab, any path) without riding an auth redirect URL
 *  or an error report. Without a fragment, keeps any earlier stash. */
export function stashSharedFragment(): void {
  const hash = window.location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const error = params.get("error");
  const payload: SharePayload =
    error === "rejected" || error === "invalid"
      ? { error }
      : {
          attemptId: crypto.randomUUID(),
          ...Object.fromEntries(
            (["title", "text", "url"] as const).flatMap((field) => {
              const value = params.get(field);
              return value === null ? [] : [[field, value]];
            }),
          ),
        };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  history.replaceState(history.state, "", window.location.pathname);
}

export function readSharedPayload(): SharePayload | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    // SAFETY: only stashSharedFragment writes this key, with a SharePayload.
    return JSON.parse(raw) as SharePayload;
  } catch {
    return null;
  }
}

export function clearSharedPayload(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** The capture body's text and optional link title for a share. Android
 *  sends links in `text`, often after the page title, and leaves `url` empty;
 *  desktop shares fill `url`. A bare link keeps the page title as its label;
 *  prose keeps its own words, with the link appended once. Null when nothing
 *  nonblank arrived. */
export function shareToCapture(share: {
  title?: string;
  text?: string;
  url?: string;
}): { text: string; title?: string } | null {
  const title = share.title?.trim() || undefined;
  const text = share.text?.trim() ?? "";
  const url = share.url?.trim() ?? "";
  const body =
    url && !text.includes(url) ? (text ? `${text} ${url}` : url) : text;
  if (!body) return title ? { text: title } : null;
  // The server only uses a title to label a lone link, and caps it at 300.
  return /^https?:\/\/\S+$/i.test(body) && title
    ? { text: body, title: title.slice(0, 300) }
    : { text: body };
}
