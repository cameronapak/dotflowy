import { createFileRoute } from "@tanstack/react-router";

import { Landing } from "@/components/Landing";

export const Route = createFileRoute("/")({
  head: () => ({
    links: [{ rel: "canonical", href: "https://dotflowy.com" }],
  }),
  component: Landing,
});
