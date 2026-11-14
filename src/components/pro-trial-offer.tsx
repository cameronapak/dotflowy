import { Schema } from "effect";
import { useState } from "react";

import { useMembership } from "../data/membership";
import { ChevronRightIcon, SparklesIcon } from "../lib/icons";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";

/** Shared by Settings and the feature offer. Nothing starts before the user
 * deliberately continues, then completes the hosted Checkout. */
export function ProTrialOffer() {
  const { trialEligible } = useMembership();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!trialEligible) return null;
  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/membership/trial", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      const decoded = Schema.decodeUnknownOption(
        Schema.Union([
          Schema.Struct({ url: Schema.String }),
          Schema.Struct({ error: Schema.String }),
        ]),
      )(await response.json());
      if (decoded._tag === "None")
        throw new Error("Couldn't open trial checkout.");
      const body = decoded.value;
      if (!response.ok || "error" in body)
        throw new Error(
          "error" in body ? body.error : "Couldn't open trial checkout.",
        );
      window.location.assign(body.url);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't open trial checkout.",
      );
      setBusy(false);
    }
  }
  return (
    <Card className="relative isolate [--card-spacing:--spacing(5)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_right,var(--primary),transparent_70%)] opacity-10"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-12 -right-12 -z-10 flex size-48 items-center justify-center rounded-full border border-primary/10"
      >
        <div className="flex size-32 items-center justify-center rounded-full border border-primary/10">
          <div className="size-16 rounded-full bg-primary/5" />
        </div>
      </div>
      <CardHeader>
        <div className="mb-3 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-9 -rotate-6 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
          >
            <SparklesIcon className="size-5" />
          </span>
          <Badge variant="secondary">14 days of Pro</Badge>
        </div>
        <CardTitle>
          <h3 className="text-xl font-semibold tracking-tight">
            Room for every idea.
          </h3>
        </CardTitle>
        <CardDescription className="text-card-foreground">
          Unlimited nodes, every theme, and your favorite AI tools.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          size="lg"
          className="min-h-11 hover:bg-primary hover:shadow-md max-sm:w-full"
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? "Opening trial checkout…" : "Start 14-day Pro trial"}
          <ChevronRightIcon data-icon="inline-end" />
        </Button>
        <span className="text-sm">No card required.</span>
      </CardContent>
      <CardFooter className="flex-col items-start gap-2 bg-card">
        <p className="text-sm text-muted-foreground">
          Complete setup in Stripe. Without a payment method, your trial ends
          after 14 days and you return to Free. If you use a saved card or add
          one, Pro renews at $5/month after your trial unless you cancel.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
