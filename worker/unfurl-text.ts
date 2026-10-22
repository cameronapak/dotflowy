import { Effect } from "effect";

import { applyUnfurlTitle, newUnfurlLinks } from "../src/data/link-unfurl";

/** Compute enrichment outside the DO transaction. Its caller must compare
 * the original text atomically before persisting this optional result. */
export const unfurlTextE = Effect.fn("Unfurl.text")(function* (
  before: string,
  text: string,
  lookup: (url: string) => Effect.Effect<string | null>,
) {
  const links = newUnfurlLinks(before, text);
  const urls = [...new Set(links.map((link) => link.url))];
  const titles = yield* Effect.forEach(urls, (url) => lookup(url), {
    concurrency: 3,
  });
  for (const link of links) {
    const title = titles[urls.indexOf(link.url)];
    if (title) text = applyUnfurlTitle(text, link, title);
  }
  return text;
});
