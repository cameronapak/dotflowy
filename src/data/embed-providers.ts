import { Schema } from "effect";

import { embedUrl } from "./embed-url";

export const EmbedProvider = Schema.Literals([
  "youtube",
  "vimeo",
  "spotify",
  "x",
]);
export type EmbedProvider = typeof EmbedProvider.Type;

const width = Schema.Number.check(
  Schema.isBetween({ minimum: 0.000001, maximum: 4096 }),
);
const height = Schema.Number.check(
  Schema.isBetween({ minimum: 0.000001, maximum: 2000 }),
);

export const EmbedDescriptor = Schema.Struct({
  provider: EmbedProvider,
  src: Schema.String,
  width,
  height,
  title: Schema.String,
});
export type EmbedDescriptor = typeof EmbedDescriptor.Type;

export const EmbedResponse = Schema.Struct({
  embed: Schema.NullOr(EmbedDescriptor),
});

export interface EmbedResource {
  readonly provider: EmbedProvider;
  readonly url: string;
  readonly id: string;
  readonly type?: string;
}

/** Strict shared allowlist. This recognizes resources; it does not authorize fetching. */
export function embedResource(text: string): EmbedResource | null {
  const value = embedUrl(text);
  if (!value) return null;
  const url = new URL(value);
  if (url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (
    host === "youtu.be" &&
    parts.length === 1 &&
    /^[\w-]{11}$/.test(parts[0]!)
  )
    return { provider: "youtube", url: value, id: parts[0]! };
  if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
    ].includes(host)
  ) {
    const id =
      url.pathname === "/watch" && parts.length === 1
        ? url.searchParams.get("v")
        : parts.length === 2 &&
            ["shorts", "embed", "live", "v"].includes(parts[0]!)
          ? parts[1]!
          : null;
    if (id && /^[\w-]{11}$/.test(id))
      return { provider: "youtube", url: value, id };
  }

  if (
    host === "vimeo.com" &&
    (parts.length === 1 || parts.length === 2) &&
    /^\d+$/.test(parts[0]!) &&
    (parts.length === 1 || /^[A-Za-z0-9]+$/.test(parts[1]!))
  )
    return { provider: "vimeo", url: value, id: parts[0]! };

  if (
    host === "open.spotify.com" &&
    parts.length === 2 &&
    ["album", "artist", "episode", "playlist", "show", "track"].includes(
      parts[0]!,
    ) &&
    /^[A-Za-z0-9]+$/.test(parts[1]!)
  )
    return { provider: "spotify", url: value, type: parts[0]!, id: parts[1]! };

  if (
    ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host) &&
    parts.length === 3 &&
    /^[A-Za-z0-9_]{1,15}$/.test(parts[0]!) &&
    parts[1] === "status" &&
    /^\d+$/.test(parts[2]!)
  )
    return { provider: "x", url: value, id: parts[2]! };
  return null;
}

export function embedProvider(text: string): EmbedProvider | null {
  return embedResource(text)?.provider ?? null;
}

/** Spotify's documented player URL is deterministic. oEmbed still supplies
 * provider dimensions when available; this keeps a recognized resource usable
 * when that metadata endpoint temporarily misses or retires an item. */
export function spotifyFallbackDescriptor(
  resource: EmbedResource | null,
): EmbedDescriptor | null {
  if (!resource || resource.provider !== "spotify" || !resource.type)
    return null;
  return {
    provider: "spotify",
    src: `https://open.spotify.com/embed/${resource.type}/${resource.id}`,
    width: 456,
    height: ["track", "episode"].includes(resource.type) ? 152 : 352,
    title: "Spotify embed",
  };
}

/** Validate provider-controlled iframe output against the requested identity. */
export function validEmbedSrc(resource: EmbedResource, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return false;
    const parts = url.pathname.split("/").filter(Boolean);
    if (resource.provider === "youtube")
      return (
        url.hostname === "www.youtube.com" &&
        parts.length === 2 &&
        parts[0] === "embed" &&
        parts[1] === resource.id
      );
    if (resource.provider === "vimeo")
      return (
        url.hostname === "player.vimeo.com" &&
        parts.length === 2 &&
        parts[0] === "video" &&
        parts[1] === resource.id
      );
    if (resource.provider === "spotify")
      return (
        url.hostname === "open.spotify.com" &&
        parts.length === 3 &&
        parts[0] === "embed" &&
        parts[1] === resource.type &&
        parts[2] === resource.id
      );
    return false;
  } catch {
    return false;
  }
}

export function embedDescriptorFromFrames(
  resource: EmbedResource,
  metadata: {
    readonly width: number;
    readonly height: number;
    readonly title: string;
  },
  frames: readonly string[],
): EmbedDescriptor | null {
  if (frames.length !== 1 || !validEmbedSrc(resource, frames[0]!)) return null;
  return Schema.decodeUnknownOption(EmbedDescriptor)({
    provider: resource.provider,
    src: frames[0]!,
    width: metadata.width,
    height: metadata.height,
    title: metadata.title,
  }).pipe((option) => (option._tag === "Some" ? option.value : null));
}
