import { createFileRoute } from "@tanstack/react-router";

import { APP_JSON_LD, faqJsonLd } from "@/components/home/blocks";
import { FAQ, Landing } from "@/components/Landing";

export const Route = createFileRoute("/")({
  // Structured data for rich results: the app and its pricing, plus the FAQ
  // exactly as the page renders it.
  head: () => ({
    links: [{ rel: "canonical", href: "https://dotflowy.com" }],
    scripts: [APP_JSON_LD, faqJsonLd(FAQ)].map((json) => ({
      type: "application/ld+json",
      children: JSON.stringify(json),
    })),
  }),
  component: Landing,
});
