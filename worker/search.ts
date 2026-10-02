import { Data, DateTime, Effect, Schema } from "effect";

import { localDateKey } from "../src/data/date-links";
import { redactSpoilers } from "../src/data/spoiler";
import { childrenOf, type TreeIndex } from "../src/data/tree";
import { searchNodes } from "./outline-ops";

export const SearchInput = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "DQL: spaces mean AND, uppercase OR joins adjacent terms, - negates, and quotes preserve phrases. Example: is:todo -is:complete #dotflowy. Unknown operators match literal text.",
  }),
  nodeId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Search this node and its reachable descendants, following mirrors. Omit for the whole outline. Collapse and hide-completed settings do not restrict search.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Matches per page (default 25, maximum 100).",
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(512)).annotate({
      description:
        "Continuation from nextCursor. Repeat the same query, scope, and limit. If searchable data changes, restart without the cursor.",
    }),
  ),
});

export const SearchPage = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      kind: Schema.NullOr(Schema.Literal("paragraph")),
      isTask: Schema.Boolean,
      completed: Schema.Boolean,
      mirrorOf: Schema.NullOr(Schema.String),
      path: Schema.Array(Schema.String),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export interface SearchPage extends Schema.Schema.Type<typeof SearchPage> {}

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  fingerprint: Schema.String,
  offset: Schema.Int.check(Schema.isGreaterThan(0)),
});

export class SearchError extends Data.TaggedError("SearchError")<{
  reason: string;
}> {
  get message() {
    return this.reason;
  }
}

export const searchPage = Effect.fn("Search.page")(function* (
  index: TreeIndex,
  input: typeof SearchInput.Type,
) {
  // Date-link reading labels depend on today. Capture it before any asynchronous
  // work, and use this same context for both the fingerprint and matching.
  const now = yield* DateTime.now;
  const today = localDateKey(DateTime.toDateUtc(now));
  const rootId = input.nodeId ?? null;
  const limit = input.limit ?? 25;
  if (rootId !== null && !index.byId.has(rootId)) {
    return yield* Effect.fail(
      new SearchError({
        reason:
          "Search root node not found. Choose an existing scope and restart without the cursor.",
      }),
    );
  }
  let cursor: typeof Cursor.Type | undefined;
  if (input.cursor !== undefined) {
    const token = input.cursor;
    cursor = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Cursor)(JSON.parse(atob(token))),
      catch: () =>
        new SearchError({
          reason: "Invalid search cursor. Restart without the cursor.",
        }),
    });
  }
  // Only agent-visible, search-relevant fields affect continuation. In
  // particular, updatedAt would leak changes inside redacted spoiler interiors.
  const snapshot = [...index.byId.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => [
      node.id,
      node.parentId,
      node.prevSiblingId,
      redactSpoilers(node.text),
      node.kind,
      node.isTask,
      node.completed,
      node.mirrorOf,
      node.origin,
      childrenOf(index, node.id).map((child) => child.id),
    ]);
  const data = new TextEncoder().encode(
    JSON.stringify([
      1,
      input.query,
      rootId,
      limit,
      today,
      snapshot,
      childrenOf(index, null).map((node) => node.id),
    ]),
  );
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", data),
    catch: () =>
      new SearchError({ reason: "Cannot create search continuation." }),
  });
  const fingerprint = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (cursor && cursor.fingerprint !== fingerprint) {
    return yield* Effect.fail(
      new SearchError({
        reason:
          "Search changed or query options differ. Restart without the cursor.",
      }),
    );
  }
  const offset = cursor?.offset ?? 0;
  const hits = searchNodes(
    index,
    input.query,
    limit + 1,
    rootId,
    offset,
    today,
  );
  if (cursor && hits.length === 0) {
    return yield* Effect.fail(
      new SearchError({
        reason: "Invalid search cursor. Restart without the cursor.",
      }),
    );
  }
  const nodes = hits.slice(0, limit);
  const nextCursor =
    hits.length > limit
      ? btoa(
          JSON.stringify({
            version: 1,
            fingerprint,
            offset: offset + nodes.length,
          }),
        )
      : null;
  return { nodes, nextCursor } satisfies SearchPage;
});
