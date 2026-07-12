/**
 * Regenerate the PWA / favicon / share raster assets from the SVG sources in
 * `public/`. Run after changing the brand mark: `bun run gen:icons`.
 *
 * Sources (hand-authored, committed):
 *   public/favicon-light.svg   full-bleed circle, transparent corners (browser tab)
 *   public/favicon-dark.svg    dark twin of the above
 *   public/icon.svg            opaque logo (white square + framed circle + dot)
 *   public/icon-maskable.svg   opaque, edge-to-edge bg + centered dot (Android mask safe-zone)
 *
 * Raster outputs (generated, committed so the build has no macOS dependency):
 *   favicon-16.png, favicon-32.png   PNG favicon fallbacks (match the SVG tab icon)
 *   favicon.ico                      classic /favicon.ico probe target (32px PNG-in-ICO)
 *   apple-touch-icon.png (180)       iOS home screen (opaque; iOS ignores SVG + manifest icons)
 *   icon-192.png, icon-512.png       manifest icons, purpose "any"
 *   icon-maskable-512.png            manifest icon, purpose "maskable"
 *
 * Rasterization uses macOS `sips` (built in) — this is a dev-time tool, not part
 * of the app build, so the macOS-only dependency is fine.
 */
import { $ } from "bun";
import { join } from "node:path";

const PUBLIC = join(import.meta.dir, "..", "public");

async function svgToPng(svg: string, out: string, size: number) {
  const src = join(PUBLIC, svg);
  const dest = join(PUBLIC, out);
  await $`sips -s format png --resampleHeightWidth ${size} ${size} ${src} --out ${dest}`.quiet();
  console.log(`  ${out}  ${size}x${size}`);
}

/** Wrap a PNG byte buffer in a single-image .ico (ICO permits embedded PNG). */
function pngToIco(png: Uint8Array, size: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(6 + 16));
  header.setUint16(0, 0, true); // reserved
  header.setUint16(2, 1, true); // type: icon
  header.setUint16(4, 1, true); // image count
  // ICONDIRENTRY (at offset 6)
  const dim = size >= 256 ? 0 : size; // 0 means 256
  header.setUint8(6, dim); // width
  header.setUint8(7, dim); // height
  header.setUint8(8, 0); // palette
  header.setUint8(9, 0); // reserved
  header.setUint16(10, 1, true); // color planes
  header.setUint16(12, 32, true); // bits per pixel
  header.setUint32(14, png.byteLength, true); // image data size
  header.setUint32(18, 22, true); // offset to image data (6 + 16)
  const out = new Uint8Array(22 + png.byteLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(png, 22);
  return out;
}

console.log("Generating icons from public/*.svg ...");

// Favicon PNG fallbacks — match the full-bleed SVG tab icon.
await svgToPng("favicon-light.svg", "favicon-16.png", 16);
await svgToPng("favicon-light.svg", "favicon-32.png", 32);

// Apple touch + manifest icons — opaque logo.
await svgToPng("icon.svg", "apple-touch-icon.png", 180);
await svgToPng("icon.svg", "icon-192.png", 192);
await svgToPng("icon.svg", "icon-512.png", 512);

// Maskable icon — edge-to-edge background for Android's mask.
await svgToPng("icon-maskable.svg", "icon-maskable-512.png", 512);

// favicon.ico — a 32px PNG embedded in an ICO container.
const ico32 = await Bun.file(join(PUBLIC, "favicon-32.png")).bytes();
await Bun.write(join(PUBLIC, "favicon.ico"), pngToIco(ico32, 32));
console.log("  favicon.ico  32x32 (PNG-in-ICO)");

console.log("Done.");
