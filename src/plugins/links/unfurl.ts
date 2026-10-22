import { Duration, Effect, Schema } from "effect";

import type { PluginContext } from "../types";

import { applyUnfurlTitle, newUnfurlLinks } from "../../data/link-unfurl";
import { getLiveNode } from "../../data/live-nodes";

const pending = new Map<string, Set<{ cancelled: boolean }>>();
export function cancelNodeUnfurl(nodeId: string): void {
  for (const request of pending.get(nodeId) ?? []) request.cancelled = true;
}

const decodeTitle = Schema.decodeUnknownEffect(
  Schema.Struct({ title: Schema.NullOr(Schema.String) }),
);

function fetchLinkTitleE(url: string): Effect.Effect<string | null> {
  return Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`, {
        signal,
      });
      return res.ok ? res.json() : { title: null };
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap(decodeTitle),
    Effect.map(({ title }) => title),
    Effect.timeoutOrElse({
      duration: Duration.seconds(8),
      orElse: () => Effect.succeed<string | null>(null),
    }),
    Effect.orElseSucceed(() => null),
  );
}

export function unfurlNodeLinks(
  nodeId: string,
  before: string,
  text: string,
  ctx: PluginContext,
  el?: HTMLElement,
): void {
  if (getLiveNode(nodeId)?.kind === "embed") return;
  const links = newUnfurlLinks(before, text);
  const urls = [...new Set(links.map((link) => link.url))];
  if (!urls.length) return;
  const request = { cancelled: false };
  const requests = pending.get(nodeId) ?? new Set();
  requests.add(request);
  pending.set(nodeId, requests);
  ctx.run(
    Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const candidates = links.filter((link) => link.url === url);
          const anchors = [
            ...(el?.querySelectorAll<HTMLElement>("a[data-link]") ?? []),
          ].filter((anchor) =>
            candidates.some(
              (link) => link.token === anchor.getAttribute("data-src"),
            ),
          );
          for (const anchor of anchors) anchor.classList.add("link-unfurling");
          const title = yield* fetchLinkTitleE(url).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                for (const anchor of anchors)
                  anchor.classList.remove("link-unfurling");
              }),
            ),
          );
          if (!title || request.cancelled) return;
          // Collection reads see other titles' optimistic writes immediately.
          const node = getLiveNode(nodeId);
          if (node?.kind === "embed") return;
          const current = node?.text;
          if (current == null) return;
          const next = candidates.reduce(
            (text, link) => applyUnfurlTitle(text, link, title),
            current,
          );
          if (next !== current) ctx.mutations.onTextChange(nodeId, next);
        }),
      { concurrency: 3, discard: true },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          requests.delete(request);
          if (!requests.size) pending.delete(nodeId);
        }),
      ),
    ),
  );
}
