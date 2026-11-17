import { expect, test } from "@playwright/test";

import { openSeededOutline, placeCaret, seedOutline, text } from "./fixtures";

const wrappers = [
  { name: "bold", marker: "**", selector: "strong" },
  { name: "bold", marker: "__", selector: "strong" },
  { name: "italic", marker: "*", selector: "em" },
  { name: "italic", marker: "_", selector: "em" },
  { name: "strike", marker: "~~", selector: "del" },
  { name: "underline", marker: "~", selector: "u" },
  { name: "highlight", marker: "==", selector: "mark" },
  { name: "spoiler", marker: "||", selector: "[data-spoiler-reveal]" },
];

const children = [
  ...wrappers.map((w) => ({
    name: w.name,
    source: `${w.marker}inside${w.marker}`,
    selector: w.name === "spoiler" ? "[data-spoiler]" : w.selector,
    label: w.name === "spoiler" ? "||inside||" : "inside",
  })),
  { name: "code", source: "`*literal*`", selector: "code", label: "*literal*" },
  {
    name: "tag",
    source: "#discipleship",
    selector: "[data-tag]",
    label: "#discipleship",
  },
  {
    name: "Bible",
    source: "John 3:16",
    selector: "[data-bible-ref]",
    label: "John 3:16",
  },
  {
    name: "link",
    source: "[visit](https://example.com)",
    selector: "a",
    label: "visit",
  },
];

for (const wrapper of wrappers) {
  test(`${wrapper.marker} composes with other inline types without losing source`, async ({
    page,
  }) => {
    const cases = children.filter((child) => child.name !== wrapper.name);
    const rows = cases.map((child, i) => ({
      id: `case-${i}`,
      parentId: null,
      prevSiblingId: i ? `case-${i - 1}` : null,
      text: `${wrapper.marker}before ${child.source} after${wrapper.marker}`,
    }));
    rows.push({
      id: "plain",
      parentId: null,
      prevSiblingId: rows.at(-1)!.id,
      text: "plain",
    });
    await seedOutline(page, rows);
    await openSeededOutline(page, { anchorId: "case-0" });
    for (const [i, child] of cases.entries()) {
      const editor = text(page, `case-${i}`);
      if (wrapper.name === "spoiler") {
        await expect(editor.locator("[data-spoiler] > *")).toHaveCount(0);
        await placeCaret(editor, wrapper.marker.length);
      }
      const outer = editor.locator(wrapper.selector).first();
      await expect(outer.locator(child.selector)).toHaveText(child.label);
      if (child.name === "code")
        await expect(outer.locator("code em")).toHaveCount(0);
      if (child.name === "tag" || child.name === "Bible") {
        const chip = outer.locator(
          child.name === "Bible" ? "[data-bible-ref] > span" : "[data-tag]",
        );
        if (wrapper.name === "bold")
          await expect(chip).toHaveCSS("font-weight", "700");
        if (wrapper.name === "italic")
          await expect(chip).toHaveCSS("font-style", "italic");
        if (wrapper.name === "strike")
          await expect(chip).toHaveCSS("text-decoration-line", "line-through");
        if (wrapper.name === "underline")
          await expect(chip).toHaveCSS("text-decoration-line", "underline");
      }
      await expect(editor).toHaveAttribute("aria-label", rows[i]!.text);
      await text(page, "plain").click();
      if (wrapper.name === "spoiler") {
        await expect(editor.locator("[data-spoiler]")).toHaveAttribute(
          "data-src",
          rows[i]!.text,
        );
        await expect(editor.locator("[data-spoiler] > *")).toHaveCount(0);
      }
    }
  });
}

test("shared delimiters and underscore aliases compose, edit, and persist", async ({
  page,
}) => {
  const sources = [
    "_THIS **IS** ITALIC_ ",
    "*THIS **IS** ITALIC*",
    "**before *inside* after**",
    "***both***",
    "___both___",
    "***bold** italic*",
    "***italic* bold**",
    "~~~strike and underline~~~",
    "**outer *middle **inner** middle* outer**",
    "~~**~chips #discipleship John 3:16~**~~",
  ];
  await seedOutline(
    page,
    sources.map((source, i) => ({
      id: `n${i}`,
      parentId: null,
      prevSiblingId: i ? `n${i - 1}` : null,
      text: source,
    })),
  );
  await openSeededOutline(page, { anchorId: "n0" });
  await expect(text(page, "n0").locator("em strong")).toHaveText("IS");
  await expect(text(page, "n1").locator("em strong")).toHaveText("IS");
  await expect(text(page, "n2").locator("strong em")).toHaveText("inside");
  for (const id of ["n3", "n4"])
    await expect(text(page, id).locator("em strong, strong em")).toHaveText(
      "both",
    );
  await expect(text(page, "n5").locator("em strong")).toHaveText("bold");
  await expect(text(page, "n6").locator("strong em")).toHaveText("italic");
  await expect(text(page, "n7").locator("del u, u del")).toHaveText(
    "strike and underline",
  );
  await expect(text(page, "n8").locator("strong em strong")).toHaveText(
    "inner",
  );
  for (const selector of ["[data-tag]", "[data-bible-ref] > span"]) {
    const chip = text(page, "n9").locator(selector);
    await expect(chip).toHaveCSS("font-weight", "700");
    await expect(chip).toHaveCSS(
      "text-decoration-line",
      "underline line-through",
    );
  }
  await placeCaret(text(page, "n0"), 10);
  await placeCaret(text(page, "n0"), 10);
  await expect(text(page, "n0").locator("strong")).not.toHaveAttribute(
    "data-src",
  );
  await placeCaret(text(page, "n0"), 10);
  await page.keyboard.type(" REALLY");
  await text(page, "n1").click();
  await expect(text(page, "n0")).toHaveAttribute(
    "aria-label",
    "_THIS **IS REALLY** ITALIC_",
  );
  await page.reload();
  await expect(text(page, "n0").locator("em strong")).toHaveText("IS REALLY");
});

test("link labels format text without nesting interactive chips or losing their source", async ({
  page,
}) => {
  const source =
    "[**bold** _italic_ ==bright== `code` #discipleship John 3:16](https://example.com)";
  await seedOutline(page, [
    { id: "link", parentId: null, prevSiblingId: null, text: source },
    { id: "plain", parentId: null, prevSiblingId: "link", text: "plain" },
  ]);
  await openSeededOutline(page, { anchorId: "link" });
  const editor = text(page, "link");
  await expect(editor.locator("a strong")).toHaveText("bold");
  await expect(editor.locator("a em")).toHaveText("italic");
  await expect(editor.locator("a mark")).toHaveText("bright");
  await expect(editor.locator("a code")).toHaveText("code");
  await expect(
    editor.locator("a [data-tag], a [data-bible-ref], a a, a button"),
  ).toHaveCount(0);
  await placeCaret(editor, 0);
  await expect(editor.locator(".link-label strong")).toHaveText("bold");
  await editor.locator(".link-url-chip").click();
  await expect(
    page.getByRole("textbox", { name: "Link text", exact: true }),
  ).toHaveValue("**bold** _italic_ ==bright== `code` #discipleship John 3:16");
});
