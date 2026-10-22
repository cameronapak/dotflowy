/// <reference types="@cloudflare/workers-types" />

import { Duration, Effect, Schema } from "effect";

import {
  embedDescriptorFromFrames,
  embedResource,
  spotifyFallbackDescriptor,
} from "../src/data/embed-providers";
import { fetchManualE, readCappedTextE } from "./unfurl";

const endpoints = {
  youtube: "https://www.youtube.com/oembed",
  vimeo: "https://vimeo.com/api/oembed.json",
  spotify: "https://open.spotify.com/oembed",
} as const;
const Oembed = Schema.Struct({
  html: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  title: Schema.String,
});
const decodeOembed = Schema.decodeUnknownEffect(Schema.fromJsonString(Oembed));

const extractFramesE = Effect.fnUntraced(function* (html: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const frames: string[] = [];
      await new HTMLRewriter()
        .on("iframe", {
          element(element) {
            const src = element.getAttribute("src");
            frames.push(src ?? "");
          },
        })
        .transform(new Response(html))
        .arrayBuffer();
      return frames;
    },
    catch: (cause) => cause,
  });
});

const lookupEmbedRawE = Effect.fnUntraced(function* (text: string) {
  const resource = embedResource(text);
  // X renders only through the official browser widget. Tweet data never
  // crosses this Worker boundary.
  if (!resource || resource.provider === "x") return null;
  const endpoint = new URL(endpoints[resource.provider]);
  const endpointTarget = `${endpoint.origin}${endpoint.pathname}`;
  endpoint.searchParams.set("url", resource.url);
  endpoint.searchParams.set("format", "json");
  const res = yield* fetchManualE(
    endpoint.href,
    "application/json",
    (target) => {
      const url = new URL(target);
      return `${url.origin}${url.pathname}` === endpointTarget;
    },
  );
  if (
    !res?.ok ||
    !/^application\/json(?:;|$)/i.test(res.headers.get("content-type") ?? "")
  ) {
    if (res?.body)
      yield* Effect.promise(() => res.body!.cancel().catch(() => undefined));
    return null;
  }
  const metadata = yield* decodeOembed(yield* readCappedTextE(res));
  return embedDescriptorFromFrames(
    resource,
    metadata,
    yield* extractFramesE(metadata.html),
  );
});

export function lookupEmbedE(text: string) {
  const fallback = spotifyFallbackDescriptor(embedResource(text));
  return lookupEmbedRawE(text).pipe(
    Effect.map((embed) => embed ?? fallback),
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () => Effect.succeed(fallback),
    }),
    Effect.orElseSucceed(() => fallback),
  );
}
