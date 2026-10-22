/**
 * Generates the landing OG image (`landing/public/og.png`, 1200x630) by
 * rendering an HTML card with the real Geist fonts and screenshotting it with
 * Playwright's chromium — no macOS-only tooling, mirrors `gen:icons`.
 *
 * The card reuses the marketing site's brand tokens (see landing/src/styles.css):
 * grayscale base, the single `--brand-blue` accent, Geist sans + Geist Mono.
 *
 * Copy is the constants below — edit them and re-run `bun run gen:og`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "landing", "public", "og.png");

// --- Copy (edit + re-run) ----------------------------------------------------
const WORDMARK = "dotflowy";
const HEADLINE_LINE_1 = "An infinite outliner,";
const HEADLINE_LEAD = "finally "; // black
const HEADLINE_ACCENT = "yours"; // brand-blue
const SUBTITLE = "The open-source alternative to Workflowy.";

// --- Brand tokens (light, from landing/src/styles.css :root) -----------------
const BG = "oklch(0.98 0 0)";
const FG = "oklch(0.27 0 0)";
const PRIMARY = "oklch(0.205 0 0)";
const MUTED = "oklch(0.556 0 0)";
const BRAND_BLUE = "oklch(0.58 0.13 250)";

function fontDataUrl(rel: string): string {
  const buf = readFileSync(join(ROOT, "node_modules", rel));
  return `data:font/woff2;base64,${buf.toString("base64")}`;
}

const geistSans = fontDataUrl(
  "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
);
const geistMono = fontDataUrl(
  "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Geist'; src: url(${geistSans}) format('woff2'); font-weight: 100 900; font-style: normal; }
  @font-face { font-family: 'Geist Mono'; src: url(${geistMono}) format('woff2'); font-weight: 100 900; font-style: normal; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background: ${BG};
    font-family: 'Geist', sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 96px;
    gap: 40px;
  }
  .wordmark {
    position: absolute; top: 96px; left: 96px;
    display: flex; align-items: center; gap: 14px;
    font-family: 'Geist Mono', monospace; font-weight: 600;
    font-size: 30px; letter-spacing: -0.01em; color: ${FG};
  }
  .dot { width: 15px; height: 15px; border-radius: 9999px; background: ${FG}; opacity: 0.7; }
  h1 {
    font-weight: 700; font-size: 92px; line-height: 1.04;
    letter-spacing: -0.035em; color: ${PRIMARY};
  }
  h1 .accent { color: ${BRAND_BLUE}; }
  p.sub { font-size: 34px; letter-spacing: -0.01em; color: ${MUTED}; }
</style></head><body>
  <div class="wordmark"><span class="dot"></span>${WORDMARK}</div>
  <h1>${HEADLINE_LINE_1}<br>${HEADLINE_LEAD}<span class="accent">${HEADLINE_ACCENT}</span>.</h1>
  <p class="sub">${SUBTITLE}</p>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.setContent(html, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: OUT });
await browser.close();

console.log(`Wrote ${OUT}`);
