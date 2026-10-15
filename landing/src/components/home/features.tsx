import type { ReactNode } from "react";

import { ChevronDown, Sun, X } from "lucide-react";

import {
  AppPage,
  NodeSwitcher,
  Row,
  TagChip,
} from "@/components/home/app-parts";
import { Dot } from "@/components/home/blocks";
import { cn } from "@/lib/utils";

/* "Everything is a bullet": each feature line beside a small, static replica
 * of the app doing that one thing. Static on purpose: the page is prerendered
 * at full opacity, and the live demo already covers motion. The replicas are
 * decorative (aria-hidden); the sentence carries the claim. */

const card =
  "bg-card shadow-[0_12px_32px_-14px_rgb(0_0_0/0.16)] dark:shadow-none";

function Zoom() {
  return (
    <AppPage
      crumbs={["Projects", "Apartment move"]}
      toolbar={false}
      title="Apartment move"
      className={card}
    >
      <Row task="done">Give notice</Row>
      <Row task="open">Movers: get 3 quotes</Row>
      <Row collapsed>Packing</Row>
    </AppPage>
  );
}

function Jump() {
  return (
    <NodeSwitcher
      query="mov"
      match="Mov"
      rest="ers: get 3 quotes"
      path="Projects › Apartment move"
      className={card}
    />
  );
}

/** The Quick-add overlay: one live bullet and the `Today ▾` destination chip. */
function Capture() {
  return (
    <div className={cn("rounded-[0.9em] border border-border p-[0.9em]", card)}>
      <Row>
        <span>
          Ask Sam about the lease
          <span className="ml-px inline-block h-[1em] w-[0.07em] translate-y-[0.15em] bg-foreground" />
        </span>
      </Row>
      <div className="mt-[0.9em] flex justify-end">
        <span className="inline-flex items-center gap-[0.35em] rounded-full border border-border px-[0.7em] py-[0.2em] text-[0.8em] text-muted-foreground">
          <Sun className="size-[1em]" strokeWidth={2} aria-hidden />
          Today
          <ChevronDown className="size-[0.9em]" strokeWidth={2} aria-hidden />
        </span>
      </div>
    </div>
  );
}

function Tags() {
  return (
    <AppPage crumbs={["Projects"]} toolbar={false} className={card}>
      <div className="mb-[0.5em] flex">
        <span className="inline-flex items-center gap-[0.3em] rounded-full border border-border py-[0.1em] pr-[0.45em] pl-[0.6em] text-[0.8em]">
          #home
          <X className="size-[0.9em] text-muted-foreground" aria-hidden />
        </span>
      </div>
      <Row>
        Movers: get 3 quotes <TagChip color="green">home</TagChip>
      </Row>
      <Row className="opacity-35">
        Landing page <TagChip color="purple">work</TagChip>
      </Row>
      <Row>
        Fix the closet door <TagChip color="green">home</TagChip>
      </Row>
    </AppPage>
  );
}

/** The same bullet under two parents, both with the mirror-blue dot. */
function Mirror() {
  return (
    <AppPage crumbs={[]} toolbar={false} className={card}>
      <Row>Thursday, October 15</Row>
      <Row depth={1} accent>
        Call the landlord about the deposit
      </Row>
      <Row>Apartment move</Row>
      <Row depth={1} accent>
        Call the landlord about the deposit
      </Row>
    </AppPage>
  );
}

function Daily() {
  return (
    <AppPage
      crumbs={["Daily", "2026", "October"]}
      toolbar={false}
      title="Thursday, October 15, 2026"
      className={card}
    >
      <Row task="done">Morning pages</Row>
      <Row task="open">Send rent</Row>
      <Row>Ask Sam about the lease</Row>
    </AppPage>
  );
}

const FEATURES: { text: string; mock: ReactNode }[] = [
  {
    text: "Zoom into any bullet and it becomes the page. The breadcrumb takes you back.",
    mock: <Zoom />,
  },
  {
    text: "Press ⌘K and type a few letters to jump to any bullet.",
    mock: <Jump />,
  },
  {
    text: "Press q to add a thought to today without leaving what you're doing.",
    mock: <Capture />,
  },
  {
    text: "Tag as you type, then filter the whole outline by a tag.",
    mock: <Tags />,
  },
  {
    text: "Mirror a bullet into more than one place. Edit it once and every copy changes.",
    mock: <Mirror />,
  },
  {
    text: "Every day gets its own page, with tasks you can check off.",
    mock: <Daily />,
  },
];

export function FeatureRows() {
  return (
    <ul className="mt-12 grid gap-14 sm:gap-16">
      {FEATURES.map((f) => (
        <li
          key={f.text}
          className="grid items-center gap-5 md:grid-cols-[minmax(0,1fr)_22rem] md:gap-12"
        >
          <p className="flex items-start gap-2.5 text-[15px] leading-relaxed text-muted-foreground">
            <Dot className="mt-2.5" />
            {f.text}
          </p>
          <div aria-hidden className="text-[14px]">
            {f.mock}
          </div>
        </li>
      ))}
    </ul>
  );
}
