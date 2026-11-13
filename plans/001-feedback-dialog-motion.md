# 001 - Smooth feedback details and clarify the form

- **Status**: DONE
- **Commit**: 4ad725a1, plus this thread's uncommitted membership implementation
- **Severity**: MEDIUM
- **Category**: Missed opportunities, accessibility
- **Estimated scope**: One component and an extension of its existing browser journey

## Implementation

Integrated the reviewed component and browser-journey changes: measured Base UI
height transitions with reduced-motion snapping and hidden collapsed controls,
clearer selected feedback types, and the ready paid-member thank-you. Isolated
typechecks, focused lint/format checks, and both feedback journeys passed; motion,
theme, narrow-screen scrolling, and membership states were inspected. Combined
checks and refreshed-portal review remain with the parent.

## Problem

In `src/components/feedback-dialog.tsx:247-283`, native details changes the height of a centered modal instantly:

```tsx
<details>
  <summary className="cursor-pointer text-sm text-muted-foreground">
    Technical details (optional)
  </summary>
  <FieldSet className="mt-3">
```

The modal has `max-h-[85dvh] overflow-y-auto` at line 137. Expanding details should smoothly grow the modal when space permits, and preserve scrolling when capped. Cam also reports that Bug, Idea, and Question look too similar when selected (`ToggleGroup`, lines 183-204), and asks for a member thank-you beside the private-context disclosure (lines 287-294).

## Target

Use the installed Base UI Collapsible directly in this component. It provides measured `--collapsible-panel-height`, open/closed attributes, and keyboard/ARIA behavior. No package or reusable wrapper is needed.

Replace native details/summary with Collapsible.Root, Trigger, and Panel. The trigger retains the exact label `Technical details (optional)` and is a non-submit button. It indicates expansion with the existing icon system or a text disclosure indicator. Keep optional diagnostic inputs and their state unchanged. Panel height transitions between 0 and `var(--collapsible-panel-height)` over **200ms**, using **cubic-bezier(0.23, 1, 0.32, 1)**. Only height transitions, never `transition-all`. Use CSS transitions so toggling can reverse in flight. Keep content mounted if needed for close transitions; collapsed controls must be hidden from keyboard and accessibility navigation. Give the panel an inner padded wrapper so margins do not escape its measured height.

This narrowly scoped, occasional disclosure is an explicit exception to the motion audit's transform/opacity-only performance preference: scaling text or only fading it would not animate the surrounding modal's layout. Do not animate the outline or add a general dialog resize observer. In reduced-motion mode, make the height change immediate; retain the disclosure's visible open/closed indication and selected type feedback.

Strengthen selected feedback type using a **foreground fill, background text, and foreground border** on `[aria-pressed=true]` within this ToggleGroup only. Preserve hover/focus states and accessible pressed state. Unselected choices remain outlined; color alone is not the only cue because selected fill/border differs and assistive technology receives pressed state. Do not change shared toggle styles.

For ready Unlimited/Founding members, prepend **“Thank you for supporting Dotflowy.”** to the existing private-context disclosure. Keep the existing account/plan/app-version and automatic collection disclosures truthful. Free, loading, and error membership states must not show the supporter thank-you.

## Repo conventions to follow

- React SPA, Tailwind v4, shadcn wrappers over Base UI. Existing `src/components/ui/accordion.tsx` uses a measured Base UI height variable. Reuse that convention without its keyframe approach, which restarts under reversal.
- Base UI installed sources: `node_modules/@base-ui/react/collapsible/panel/CollapsiblePanel.d.ts` and `useCollapsiblePanel.js` describe panel lifecycle/measurement. The trigger is a button with `aria-expanded`.
- `src/components/ui/dialog.tsx` owns modal centering and entry/exit motion. Leave it unchanged.
- The project uses semantic colors. Respect theme and Mode. `docs/adr/0078-writing-chrome.md` documents deliberate 600ms editor chrome fades; this task does not audit or alter them.
- Extend `e2e/feedback.spec.ts` instead of adding a new suite. Read CONTRIBUTING.md's testing section: don't pin exact copy, styling classes, or timing in kept tests.

## Steps

1. Implement the component changes above in an isolated worktree containing the source thread's exact uncommitted snapshot, not plain HEAD. The source repository is `/home/user/workspace/repo`; the remote is `cameronapak/dotflowy`. None of the membership work is on origin/main.
2. Extend the existing feedback journey to cover disclosure expand/collapse, preserved diagnostic opt-in after reopening, keyboard semantics, and one selected feedback type. Keep visual/timing probes temporary rather than committed tests of CSS internals.
3. Render the real app at 1168×650 and 390×844 in light and dark. Inspect collapsed and expanded forms, selected Bug/Idea/Question, supporter copy for Founding and Unlimited, and no supporter copy for Free. Check at least default and a premium palette.
4. Probe normal motion at intermediate frames, rapid reversal, and reduced motion. Record the real pointer crossing neighboring controls, selecting a type, expanding/collapsing details, and inspect the clip before reporting.

## Boundaries

- Edit only `src/components/feedback-dialog.tsx` and `e2e/feedback.spec.ts`, unless an actual limitation requires reporting a deviation first.
- Preserve the source thread's uncommitted work and unrelated files. No package installs, shared UI edits, API, billing, database, or privacy-policy changes.
- Do not push, commit, deploy, or write production data.
- No global animation audit. Cam selected this one disclosure and two adjacent clarity changes.
- If the cited component differs materially, report drift instead of guessing. Small line-number shifts do not constitute drift.

## Verification

- Mechanical: `bun run typecheck`, `bun run typecheck:e2e`, focused oxlint/oxfmt checks, `bun run test:e2e:app e2e/feedback.spec.ts --workers=1`, and `git diff --check`, all exit 0.
- Feel check: use the real local `bun run cf:dev` app, or the existing local portal, not production. Expansion grows from current height and collapse returns smoothly; rapid toggles do not flash or restart from zero. Inspect slow-motion frames at approximately 10% playback.
- Confirm at the narrow width that the dialog stays inside the viewport, can scroll to its final actions, and neither the diagnostic browser text nor type choices overflow.
- Emulate prefers-reduced-motion and confirm the height snaps without positional tweening, while selected feedback and open/closed indication remain clear.
- Done when the three review comments are addressed without changing submission payloads, idempotency, privacy, paid authorization, or unrelated component behavior. Return a minimal diff against the exact source snapshot, verification results, and screenshots/recording for integration review.
