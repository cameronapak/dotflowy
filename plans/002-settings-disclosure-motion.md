# 002 - Repair Settings disclosure opening and closing

- **Status**: DONE
- **Commit**: f9d7c6d0, plus concurrent uncommitted Split Connections work observed during the audit
- **Severity**: HIGH
- **Category**: Missed opportunities, interruptibility, accessibility
- **Estimated scope**: S; one shared component, one existing browser journey; no dependencies

## Implementation evidence

Implemented locally with the Split Connections layout. In Chromium against
`bun run cf:dev`, the original Embeds panel jumped between 0 and 87px. Its
computed closing keyframes were `height: auto` to `height: 0px`, confirming the
incompatible keyframes in the actual failing path. After the change, opening
sampled 0, 29.28, 52.33, 67.44, and 87px; closing sampled 87, 57.52, 34.52,
19.53, and 0px. Rapid reversal continued from the displayed height. Reduced
motion computed `transition-property: none` and snapped closed; closing and
closed panels were inert.

App and e2e typechecks, focused lint, doc-pointer checks, and the 31-test
Settings/editor-feature/API-key Chromium run passed. Desktop expanded/collapsed,
narrow dark-mode access with sample data, and a real-pointer recording were
rendered and inspected. Release status is tracked in the implementation thread.

## Problem

The advisor identified the source mismatch below without starting the app,
compiling CSS, or sampling animation frames. The implementation pass then
reproduced the snapping and verified the generated keyframes, as recorded above.
The remaining sections preserve the original self-contained implementation plan.

`src/components/ui/accordion.tsx:61-73` currently splits the animation between
two different elements:

```tsx
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="overflow-hidden text-sm data-open:animate-accordion-down data-closed:animate-accordion-up"
      {...props}
    >
      <div
        className={cn(
          "h-(--accordion-panel-height) pt-0 pb-2.5 data-ending-style:h-0 data-starting-style:h-0 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
          className,
        )}
      >
        {children}
      </div>
```

The child inherits the height variable but not attributes. Base UI puts
`data-starting-style` and `data-ending-style` on Panel itself; those child
selectors cannot respond to Panel's state. There is no height transition on
either element. Existing keyframes are the only remaining motion path.

There is also a relevant keyframe-name collision:

- `src/styles.css:1-3` imports Tailwind, `shadcn/tailwind.css`, then
  `tw-animate-css`.
- `node_modules/shadcn/dist/tailwind.css:1-25` defines `accordion-down/up`
  with `var(--radix-accordion-content-height, var(--accordion-panel-height, auto))`.
- `node_modules/tw-animate-css/dist/tw-animate.css:1` defines the same names,
  but its height fallback chain is Radix → Bits → Reka → Kobalte → NGP → `auto`;
  **it does not include Base UI's `--accordion-panel-height`**. Its duration
  defaults to `.2s` and easing to `ease-out`. Here is its exact down keyframe:

```css
@keyframes accordion-down {
  from {
    height: 0;
  }
  to {
    height: var(
      --radix-accordion-content-height,
      var(
        --bits-accordion-content-height,
        var(
          --reka-accordion-content-height,
          var(
            --kb-accordion-content-height,
            var(--ngp-accordion-content-height, auto)
          )
        )
      )
    );
  }
}
```

The later import suggests the incompatible definition can win; generated CSS
and computed styles must establish that. Do not report the animation utilities
as missing, or `data-closed` as unsupported. Base UI supports it through
`node_modules/@base-ui/react/utils/collapsibleOpenStateMapping.js:10-32`.

Base UI 1.8.0's actual lifecycle supports the proposed transition:

- `node_modules/@base-ui/react/accordion/panel/AccordionPanel.js:70-122`
  delegates measurement to `useCollapsiblePanel`, attaches height to Panel,
  and maps Panel's transition status into attributes.
- `node_modules/@base-ui/react/internals/stateAttributesMapping.js:10-25`
  maps `starting`/`ending` to the corresponding attributes on that element.
- `node_modules/@base-ui/react/collapsible/root/useCollapsibleRoot.js:29-33`
  enables an idle state and defers ending by a frame;
  `internals/useTransitionStatus.js:21-74` sequences those phases.
- `node_modules/@base-ui/react/collapsible/panel/useCollapsiblePanel.js:150-269`
  measures on open/close, clears measured dimensions back to `auto` after open,
  and waits for close motion before unmounting. Lines 320-337 detect animation
  or transition on **Panel**, not its padded child.

Consumer audit: `src/routes/settings.tsx` is the only consuming file in `src/`.
It renders plugin options in `PluginsSection` (`:1005-1103`), retaining
single-open controlled state and URL-hash opening (`:998-1015`). During this
audit the layout owner added `ConnectionsSection` disclosures (`:598-734`):
Set up and Access use a separate `multiple` Accordion. They were initially open
at audit time; Cam subsequently selected collapsed defaults, with direct Access
hash links opening that group.
Access explicitly uses `keepMounted` (`:724`); preserve that choice. Neither
consumer supplies a custom Panel renderer. The wrapper's `className` applies
to the inner div; both consumers rely on `pb-0`, and Connections adds borders
and dividers there. Preserve that contract.

The top-level `Section` is not collapsible (`settings.tsx:111-130`), and
“Other settings” is native details (`:1352-1360`). The in-progress Split
Connections layout remains owned by the layout implementer. This plan repairs
its shared motion seam as well as existing plugin panels, not product structure
or default-open policy. Settings line numbers reflect the concurrent worktree,
not just the commit stamp, and can shift as that work is completed.

## Target

Animate only Panel height from `0` to `var(--accordion-panel-height)` and back:
**200ms cubic-bezier(0.23, 1, 0.32, 1)**, no delay, CSS transition rather than
keyframes. Opening and closing must retarget without resetting to an endpoint
when interrupted. Keep padding on the inner div so the clipping Panel can reach
zero without a padding floor or height feedback loop. Base UI returns the
variable to `auto` after opening, allowing option content to change naturally.

This occasional Settings disclosure explicitly shares plan 001's measured-height
performance exception: surrounding content must reflow; scaling readable text
or fading alone cannot do that. Do not use Motion layout animation, a maximum
height guess, observers, timers, new animation tokens, or dependency upgrades.

Reduced motion snaps height immediately via `motion-reduce:transition-none`.
Keep the existing visible chevron state; do not add opacity, slide, rotation,
stagger, or press effects. During closing, retained controls must not stay
keyboard/assistive-technology targets; use the existing feedback panel's
`inert`/`aria-hidden` render pattern as the default renderer.

Exact replacement for `AccordionContent` in `src/components/ui/accordion.tsx`:

```tsx
function AccordionContent({
  className,
  children,
  ...props
}: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
      render={(panelProps, state) => (
        <div {...panelProps} inert={!state.open} aria-hidden={!state.open} />
      )}
      {...props}
    >
      <div
        className={cn(
          "pt-0 pb-2.5 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
          className,
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  );
}
```

Keep prop spread order: caller-supplied `render` remains an explicit override;
no current Settings consumer supplies it. Do not add or remove `keepMounted`:
Base UI already keeps closing panels through transitions, then unmounts them
by default or hides them when the caller explicitly requests retention.

## Repo conventions to follow

- `src/components/feedback-dialog.tsx:272-282` already uses measured-height
  transitions, the exact 200ms curve, reduced-motion snapping, an inner padded
  wrapper, and an inert/aria-hidden render callback. Plan 001 documents why.
- Keep Tailwind classes local to this wrapper; do not alter either package's
  keyframe definitions or global `src/styles.css` imports.
- `e2e/editor-features.spec.ts:39-65` already exercises single-open plugin
  options. Extend it instead of creating a timing-pinned suite.
- `CONTRIBUTING.md:274-305` keeps styling and animation timings unpinned in
  durable tests; browser frame probes are temporary evidence instead.
- Preserve `docs/adr/0078-writing-chrome.md:18-21`: deliberate 600ms editor
  fades are unrelated and are not findings in this audit.

## Steps

1. Before editing, render the current app with `bun run cf:dev` (or its existing
   supervised service). Open `/settings`; expand and collapse Embeds options.
   Inspect the Panel and child attributes, computed height, animation name,
   duration, and the winning `accordion-down/up` keyframes in generated CSS.
   Capture before frames to distinguish an absent tween from a merely fast one.
   No production access. If the layout implementation has changed the component
   seam, stop and report semantic drift rather than applying stale markup.
2. Extend the existing plugin workflow in `e2e/editor-features.spec.ts` before
   changing the wrapper: verify `aria-expanded`, explicitly close and reopen
   one plugin, use Enter/Space on its trigger, and assert its controls disappear
   from accessible navigation after closing. Preserve the single-open and
   persisted-feature assertions. These retained tests protect behavior, not
   the tween; use the temporary before/after browser probe for motion itself.
3. Replace only `AccordionContent` with the target above. Leave Trigger's two
   icons and its unrelated focus/hover transition unchanged. No settings route
   edits are required for existing plugin panels. The layout owner can use
   this identical measured-panel recipe with Base UI Collapsible for any future
   independent disclosure, substituting `--collapsible-panel-height`. Preserve
   the new Connections Accordion's `multiple` behavior; independent sections
   must not become mutually exclusive just to reuse motion.
4. Run the mechanical checks and the before/after feel check below. Remove
   temporary scripts/probes. Include a root changeset in the implementation PR
   per the existing release convention; the advisor writes no source/changeset.

## Boundaries

- Source scope: `src/components/ui/accordion.tsx` and the existing plugin
  journey in `e2e/editor-features.spec.ts`, plus the implementation's changeset.
- No Split Connections layout work, new preferences, default-open decisions,
  plugin enabled-state behavior, route/hash changes, or native details redesign.
- No global animation audit or roadmap. No editor motion, feedback dialog,
  global theme/token consolidation, library upgrades, builds, or installs.
- Preserve inner `className`, `pb-0`, region/heading/button semantics, Base UI
  IDs/ARIA and refs from spread props, and Settings feature persistence.
- If steps do not match the code, stop and report drift. A mere line-number
  shift is not drift; a different disclosure owner or lifecycle is.

## Verification

- **Mechanical (executor only; not run by advisor)**:
  - `bun run typecheck`
  - `bun run typecheck:e2e`
  - `bun run test:e2e:app e2e/editor-features.spec.ts e2e/settings.spec.ts --project=chromium --workers=1`
  - `git diff --check`
  - Expected: all exit 0; no Base UI warning about simultaneous transitions
    and animations on Panel. Existing settings journeys must remain intact.
- **Feel check**: use the real `bun run cf:dev` app at 1168×650 and 390×844,
  normal and reduced motion. Check Daily notes, Embeds, and tall Focus sessions
  panels and the new Set up/Access Connections panels in both directions.
  Verify Connections can have both panels open and retained Access content is
  hidden/inert when closed, while its state survives reopening. In DevTools
  slow animation playback to 10%, or
  sample browser animation progress, and confirm visible intermediate heights,
  sibling content reflow, no clipped resting content or residual closed gap,
  and no non-`none` accordion keyframe animation on Panel.
- Reverse opening into closing and closing into reopening before completion,
  including switching between two plugin panels. Motion must continue from
  the currently displayed height, without a full-height flash, blank flash,
  stale unmount, or reset to zero. If Base UI's installed lifecycle does not
  meet this check, report it rather than adding bespoke state or timers.
- On `/settings#embeds`, initial content should be visible without forcing an
  entrance animation. Changing a hash while Settings is mounted must still
  open the correct options. Change an option while open and confirm the panel
  is not stuck at an obsolete fixed height.
- Emulate `prefers-reduced-motion: reduce`: no height tween, no delayed close,
  chevron/ARIA state remains immediate and correct. Tab/Shift+Tab cannot reach
  closing or closed controls; Enter and Space still toggle the trigger.
- **Done when**: normal motion has evidenced intermediate frames in both
  directions, reversals pass, reduced motion snaps, and existing plugin/hash
  behavior survives. Return before/after evidence and truthful check results.
