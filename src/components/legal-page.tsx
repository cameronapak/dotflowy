import type { ReactNode } from "react";

/**
 * Renders the committed legal drafts (`docs/legal/*.md`, imported as raw
 * strings via Vite `?raw`) as public, prerender-safe pages — no data layer,
 * no dependency. The markdown surface those drafts use is small and fixed
 * (h1/h2/h3, paragraphs, `-` lists, `**bold**`, and `[text](url)` links), so a
 * focused parser returning React nodes is faithful and avoids both a markdown
 * dependency and `dangerouslySetInnerHTML`. Anything richer than that grammar
 * lands verbatim as text rather than mis-rendering.
 *
 * These routes render OUTSIDE the root AuthGate (see `__root.tsx`
 * `PUBLIC_ROUTES`) so a signed-out visitor — or a crawler — can read them.
 */

/** Split the source into blank-line-separated blocks. */
function splitBlocks(md: string): string[] {
  return md
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/** Map a markdown link href to what the app should navigate to: a relative
 *  `./privacy.md` becomes the SPA route `/privacy`; everything else is left
 *  as-authored (mailto:, http(s)://). */
function resolveHref(href: string): string {
  const md = href.match(/^\.?\/?([\w-]+)\.md$/);
  return md ? `/${md[1]}` : href;
}

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;

/** Parse the inline grammar (`**bold**`, `[text](url)`) into React nodes. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    if (match[1] !== undefined) {
      nodes.push(
        <strong
          key={`${keyPrefix}-b${i}`}
          className="font-semibold text-foreground"
        >
          {match[1]}
        </strong>,
      );
    } else {
      const href = resolveHref(match[3] ?? "");
      const external = /^https?:\/\//.test(href);
      nodes.push(
        <a
          key={`${keyPrefix}-a${i}`}
          href={href}
          {...(external
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
          className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
        >
          {match[2]}
        </a>,
      );
    }
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render one block (heading / list / paragraph) to a React element. */
function renderBlock(block: string, key: number): ReactNode {
  const heading = block.match(/^(#{1,3})\s+(.*)$/);
  if (heading) {
    const level = (heading[1] ?? "").length;
    const content = renderInline(heading[2] ?? "", `h${key}`);
    if (level === 1)
      return (
        <h1
          key={key}
          className="mt-0 mb-6 text-2xl font-semibold tracking-tight text-foreground"
        >
          {content}
        </h1>
      );
    if (level === 2)
      return (
        <h2
          key={key}
          className="mt-10 mb-3 text-lg font-semibold tracking-tight text-foreground"
        >
          {content}
        </h2>
      );
    return (
      <h3
        key={key}
        className="mt-6 mb-2 text-base font-semibold text-foreground"
      >
        {content}
      </h3>
    );
  }

  const lines = block.split("\n");
  if (lines.every((l) => /^[-*]\s+/.test(l))) {
    return (
      <ul key={key} className="my-4 list-disc space-y-2 pl-6">
        {lines.map((l, idx) => (
          <li key={idx}>
            {renderInline(l.replace(/^[-*]\s+/, ""), `l${key}-${idx}`)}
          </li>
        ))}
      </ul>
    );
  }

  // A plain paragraph — join wrapped lines with a space.
  return (
    <p key={key} className="my-4 leading-relaxed">
      {renderInline(lines.join(" "), `p${key}`)}
    </p>
  );
}

export function LegalPage({ markdown }: Readonly<{ markdown: string }>) {
  const blocks = splitBlocks(markdown);
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <div className="mb-8 border-b border-border pb-4">
          <a
            href="/"
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            ← Back to Dotflowy
          </a>
        </div>
        <article className="text-sm text-muted-foreground">
          {blocks.map((block, i) => renderBlock(block, i))}
        </article>
      </div>
    </main>
  );
}
