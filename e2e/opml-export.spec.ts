import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// App OPML export (ADR 0037, issue #127): the "Export OPML" More-menu item /
// Cmd+K global action downloads the current view (zoom root INCLUDED, or the
// whole outline at home) serialized by the shared core (src/data/opml-export.ts).
//
// The download is intercepted IN PAGE (no real filesystem download): we shadow
// HTMLAnchorElement.prototype.click for blob: hrefs and record the anchor's
// `download` filename + the blob's text. `downloadTextFile` revokes the object
// URL right after click, so the blob text is captured eagerly at click time.

//   Project alpha (root)          <- the zoom target
//     Done item (done)            completed
//     Task item (task)            to-do
//     Source item (source)        mirror source, has a child
//       Source child (source-kid)
//     (mirror of source) (mir)    mirror root
//   Other top level (other)       <- must NOT appear in a zoomed export
const TREE: SeedNode[] = [
  { id: "root", parentId: null, prevSiblingId: null, text: "Project alpha" },
  {
    id: "other",
    parentId: null,
    prevSiblingId: "root",
    text: "Other top level",
  },
  {
    id: "done",
    parentId: "root",
    prevSiblingId: null,
    text: "Done item",
    completed: true,
  },
  {
    id: "task",
    parentId: "root",
    prevSiblingId: "done",
    text: "Task item",
    isTask: true,
  },
  {
    id: "source",
    parentId: "root",
    prevSiblingId: "task",
    text: "Source item",
  },
  {
    id: "source-kid",
    parentId: "source",
    prevSiblingId: null,
    text: "Source child",
  },
  {
    id: "mir",
    parentId: "root",
    prevSiblingId: "source",
    text: "mirror placeholder",
    mirrorOf: "source",
  },
];

interface CapturedDownload {
  filename: string;
  text: string;
}

declare global {
  interface Window {
    __downloads?: Promise<CapturedDownload>[];
  }
}

/** Shadow blob-anchor clicks so a download is captured in page, not saved. */
async function interceptDownloads(page: Page) {
  await page.addInitScript(() => {
    window.__downloads = [];
    const blobs = new Map<string, Blob>();
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      const url = origCreate(b);
      if (b instanceof Blob) blobs.set(url, b);
      return url;
    };
    // Shadows HTMLElement.prototype.click for anchors only; non-blob anchors
    // fall through to the real click.
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      if (!blob) return HTMLElement.prototype.click.call(this);
      const filename = this.download;
      window.__downloads!.push(
        blob.text().then((text) => ({ filename, text })),
      );
    };
  });
}

async function capturedDownload(page: Page): Promise<CapturedDownload> {
  await expect
    .poll(() => page.evaluate(() => window.__downloads!.length))
    .toBeGreaterThan(0);
  return page.evaluate(() =>
    Promise.all(window.__downloads!).then((d) => d[0]!),
  );
}

const nodeText = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function runMenuExport(page: Page) {
  await page.getByRole("button", { name: /more/i }).click();
  await page.getByRole("menuitem", { name: /Export OPML/ }).click();
}

test.describe("OPML export (More menu + Cmd+K)", () => {
  test("zoomed export: subtree only, root as top-level outline, dialect attrs, no ownerEmail", async ({
    page,
  }) => {
    await interceptDownloads(page);
    await seedOutline(page, TREE);
    await page.goto("/root");
    await expect(nodeText(page, "done")).toBeVisible();

    await runMenuExport(page);
    const { filename, text } = await capturedDownload(page);

    // Filename: dotflowy-<slug>-<local date>.opml.
    expect(filename).toMatch(
      /^dotflowy-project-alpha-\d{4}-\d{2}-\d{2}\.opml$/,
    );

    // OPML shell, title-only head -- never ownerEmail (privacy, ADR 0037).
    expect(text).toContain('<opml version="2.0">');
    expect(text).toContain("<title>Project alpha</title>");
    expect(text).not.toContain("ownerEmail");

    // Scope: the zoom root is the single top-level <outline>; the sibling
    // top-level node is outside the subtree and absent.
    expect(text).toContain('text="Project alpha"');
    expect(text).not.toContain("Other top level");

    // completed -> _complete="true"; to-do -> _task="true" (present-iff-true).
    expect(text).toContain('_complete="true" text="Done item"');
    expect(text).toContain('_task="true" text="Task item"');
    expect(text.match(/_complete=/g)).toHaveLength(1);
    expect(text.match(/_task=/g)).toHaveLength(1);

    // Mirror dialect: the in-scope source carries id=..., the mirror root
    // carries _mirror=<sourceId> and emits the fully resolved duplicate
    // (source text AND its child, repeated inside the mirror's expansion).
    expect(text).toContain('id="source"');
    expect(text).toContain('_mirror="source" text="Source item"');
    expect(text.match(/text="Source item"/g)).toHaveLength(2);
    expect(text.match(/text="Source child"/g)).toHaveLength(2);
  });

  test("home export includes every top-level node under the default filename", async ({
    page,
  }) => {
    await interceptDownloads(page);
    await seedOutline(page, TREE);
    await page.goto("/");
    await expect(nodeText(page, "root")).toBeVisible();

    await runMenuExport(page);
    const { filename, text } = await capturedDownload(page);

    expect(filename).toMatch(/^dotflowy-export-\d{4}-\d{2}-\d{2}\.opml$/);
    expect(text).toContain('text="Project alpha"');
    expect(text).toContain('text="Other top level"');
  });

  test("Cmd+K runs Export OPML through the global-actions bridge", async ({
    page,
  }) => {
    await interceptDownloads(page);
    await seedOutline(page, TREE);
    await page.goto("/");
    await expect(nodeText(page, "root")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByPlaceholder(/Search nodes and actions/);
    await expect(input).toBeVisible();
    await input.fill("export opml");
    await page.getByRole("option", { name: /Export OPML/ }).click();

    const { filename } = await capturedDownload(page);
    expect(filename).toMatch(/^dotflowy-export-\d{4}-\d{2}-\d{2}\.opml$/);
  });
});
