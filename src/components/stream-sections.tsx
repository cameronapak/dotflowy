// Section chrome for the view stream (ADR 0070): the windowed list items that
// are not outline rows -- a placeholder section's title and first line, a fold
// of empty sections, and the page end that fills each section to a screen.
// Section titles with a node reuse the zoomed title (OutlineEditor).

import type { ReactNode } from "react";

import { useRef } from "react";

interface ShellProps {
  kind: "title" | "placeholder" | "fold" | "end";
  section: string;
  index: number;
  start: number;
  scrollMargin: number;
  measureRef: (el: HTMLLIElement | null) => void;
  children: ReactNode;
  height?: number;
}

/** A windowed list item positioned like an outline row. */
export function StreamShell({
  kind,
  section,
  index,
  start,
  scrollMargin,
  measureRef,
  children,
  height,
}: ShellProps) {
  return (
    <li
      className="stream-item"
      data-stream-item={kind}
      data-section={section}
      data-index={index}
      ref={measureRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        minHeight: height,
        transform: `translateY(${start - scrollMargin}px)`,
      }}
    >
      {children}
    </li>
  );
}

/** The title of a section that has no node yet. Read-only: the date is the
 *  identity, and nothing exists to rename. */
export function StreamPlaceholderTitle({
  title,
  badge,
}: {
  title: string;
  badge: string | null;
}) {
  return (
    <h2 className="zoomed-title stream-title" data-placeholder="">
      <span className="row-body">
        {badge ? <span className="stream-badge">{badge}</span> : null}
        <span className="zoomed-title-text stream-placeholder-text">
          {title}
        </span>
      </span>
    </h2>
  );
}

/**
 * The faint first line of an empty section. Typing in it starts the section:
 * `onWrite` runs once, on the first input, and owns creating the node and
 * moving the caret to the real row. Enter does nothing until then.
 */
export function StreamEntryLine({
  section,
  onWrite,
}: {
  section: string;
  onWrite: (section: string, el: HTMLElement) => void;
}) {
  const started = useRef(false);
  return (
    <div className="outline-row stream-entry">
      <span className="collapse-toggle touch-hitbox" aria-hidden="true" />
      <span className="bullet touch-hitbox" aria-hidden="true">
        <span className="bullet-dot" />
      </span>
      <span
        className="stream-entry-text"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-label="Write something"
        data-placeholder="Write something…"
        data-stream-entry={section}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        onPaste={(e) => {
          // Plain text only: the real row's paste pipeline takes over once the
          // section exists.
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain").split("\n")[0];
          document.execCommand("insertText", false, text ?? "");
        }}
        onInput={(e) => {
          if (started.current) return;
          if (!e.currentTarget.textContent) return;
          started.current = true;
          onWrite(section, e.currentTarget);
        }}
      />
    </div>
  );
}

/** One line standing in for a run of empty sections. Expands on click. */
export function StreamFold({
  label,
  onExpand,
}: {
  label: string;
  onExpand: () => void;
}) {
  return (
    <button type="button" className="stream-fold" onClick={onExpand}>
      <span aria-hidden="true" className="stream-fold-mark">
        ···
      </span>
      <span>{label}</span>
    </button>
  );
}
