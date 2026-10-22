import { expect, test } from "bun:test";
import { Schema } from "effect";

import {
  EmbedDescriptor,
  embedDescriptorFromFrames,
  embedProvider,
  embedResource,
  spotifyFallbackDescriptor,
  validEmbedSrc,
} from "./embed-providers";

test("recognizes strict resource forms and preserves significant input", () => {
  expect(embedProvider("https://youtu.be/dQw4w9WgXcQ?t=43")).toBe("youtube");
  expect(embedProvider("https://vimeo.com/123456/UnlistedHash")).toBe("vimeo");
  expect(embedProvider("https://open.spotify.com/track/abc123?si=xyz")).toBe(
    "spotify",
  );
  expect(embedProvider("https://x.com/user/status/123456789")).toBe("x");
  expect(embedResource("https://youtu.be/dQw4w9WgXcQ?t=43")?.url).toContain(
    "t=43",
  );
  expect(embedResource("https://vimeo.com/123456/UnlistedHash")?.url).toContain(
    "UnlistedHash",
  );
});

test("rejects credentials, evil hosts, and loose paths", () => {
  for (const value of [
    "https://user@example.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch/extra?v=dQw4w9WgXcQ",
    "https://vimeo.com/channels/staffpicks/123456",
    "https://open.spotify.com/embed/track/abc123",
    "https://x.com/user/status/not-a-number",
  ])
    expect(embedProvider(value)).toBeNull();
});

test("iframe source must be the same provider resource", () => {
  const youtube = embedResource("https://youtube.com/watch?v=dQw4w9WgXcQ")!;
  expect(
    validEmbedSrc(
      youtube,
      "https://www.youtube.com/embed/dQw4w9WgXcQ?start=43",
    ),
  ).toBe(true);
  expect(
    validEmbedSrc(youtube, "https://www.youtube.com/embed/aaaaaaaaaaa"),
  ).toBe(false);
  expect(
    validEmbedSrc(
      youtube,
      "https://www.youtube.com.evil.test/embed/dQw4w9WgXcQ",
    ),
  ).toBe(false);
});

test("descriptor schema bounds dimensions", () => {
  const valid = {
    provider: "youtube",
    src: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    width: 4096,
    height: 2000,
    title: "Video",
  };
  expect(Schema.is(EmbedDescriptor)(valid)).toBe(true);
  expect(Schema.is(EmbedDescriptor)({ ...valid, width: 0 })).toBe(false);
  expect(Schema.is(EmbedDescriptor)({ ...valid, width: 4097 })).toBe(false);
  expect(Schema.is(EmbedDescriptor)({ ...valid, height: Number.NaN })).toBe(
    false,
  );
});

test("descriptor requires exactly one matching frame", () => {
  const resource = embedResource("https://vimeo.com/123456/secretHash")!;
  const metadata = { width: 640, height: 360, title: "Vimeo" };
  const src = "https://player.vimeo.com/video/123456?h=secretHash";
  expect(embedDescriptorFromFrames(resource, metadata, [])).toBeNull();
  expect(embedDescriptorFromFrames(resource, metadata, [src, src])).toBeNull();
  expect(
    embedDescriptorFromFrames(resource, metadata, [
      "https://player.vimeo.com/video/999",
    ]),
  ).toBeNull();
  expect(embedDescriptorFromFrames(resource, metadata, [src])?.src).toBe(src);
});

test("Spotify uses provider dimensions instead of assuming a compact player", () => {
  const resource = embedResource("https://open.spotify.com/track/abc123")!;
  const src = "https://open.spotify.com/embed/track/abc123";
  expect(
    embedDescriptorFromFrames(
      resource,
      { width: 624, height: 351, title: "Music video" },
      [src],
    )?.height,
  ).toBe(351);
  expect(
    embedDescriptorFromFrames(
      resource,
      { width: 456, height: -1, title: "Bad dimensions" },
      [src],
    ),
  ).toBeNull();
});

test("Spotify has an official player fallback when oEmbed metadata misses", () => {
  const episode = embedResource(
    "https://open.spotify.com/episode/abc123?si=tracking",
  )!;
  expect(spotifyFallbackDescriptor(episode)).toMatchObject({
    provider: "spotify",
    src: "https://open.spotify.com/embed/episode/abc123",
    width: 456,
    height: 152,
  });
  const playlist = embedResource("https://open.spotify.com/playlist/abc123")!;
  expect(spotifyFallbackDescriptor(playlist)?.height).toBe(352);
  expect(
    spotifyFallbackDescriptor(
      embedResource("https://youtube.com/watch?v=dQw4w9WgXcQ")!,
    ),
  ).toBeNull();
});
