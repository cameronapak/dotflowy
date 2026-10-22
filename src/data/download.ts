// Client-only browser download helper (ADR 0037): Blob -> object URL -> a
// programmatic `<a download>` click. The OPML export action rides this; any
// future "save as file" surface (JSON backup, markdown file) should too.
// Never import this from the Worker -- it touches DOM globals.

/** Trigger a browser download of `text` as `filename` with the given MIME. */
export function downloadTextFile(
  filename: string,
  mime: string,
  text: string,
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
