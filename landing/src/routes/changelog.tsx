import { createFileRoute } from "@tanstack/react-router";

import { ChangelogList } from "@/components/Changelog";
import { Footer, Nav } from "@/components/SiteChrome";
import { RELEASES_URL, releases } from "@/lib/changelog-data";

const TITLE = "What's new — Dotflowy";
const DESCRIPTION =
  "Every change to Dotflowy, newest first. No sign-in required.";
const URL = "https://dotflowy.com/changelog";

export const Route = createFileRoute("/changelog")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:url", content: URL },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
    links: [{ rel: "canonical", href: URL }],
  }),
  component: ChangelogPage,
});

function ChangelogPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <section className="pt-14 pb-24 sm:pt-20">
          <div className="mx-auto w-full max-w-2xl px-6">
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              What&apos;s new
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-pretty text-muted-foreground">
              Every change to Dotflowy, newest first.
            </p>
            <div className="mt-12">
              <ChangelogList releases={releases} />
            </div>
            <p className="mt-14 text-sm text-muted-foreground">
              Prefer a feed?{" "}
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground underline-offset-4 hover:underline"
              >
                GitHub Releases
              </a>
              .
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
