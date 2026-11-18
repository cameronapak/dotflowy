import { Link } from "@tanstack/react-router";
import { Effect, Fiber, Schema } from "effect";
import { useEffect, useId, useRef, useState } from "react";

import { useMembership } from "../data/membership";
import { RewardResult, type Reward } from "../data/pro-reward";
import { RewardRequestError, saveReward } from "../data/pro-reward-api";
import { signOutAndReload } from "../lib/auth-client";
import { Button } from "./ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

const loadReward = Effect.fn("loadReward")(function* (reportId: number) {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  );
  const response = yield* Effect.tryPromise((signal) =>
    fetch(`/api/admin/pro-rewards?reportId=${reportId}`, {
      signal: AbortSignal.any([signal, controller.signal]),
    }),
  );
  if (!response.ok) {
    return yield* Effect.fail(
      new RewardRequestError({
        reason: "server",
        message:
          "Couldn't load reward history. Refresh before issuing a reward.",
      }),
    );
  }
  const data: unknown = yield* Effect.tryPromise(() => response.json());
  return yield* Schema.decodeUnknownEffect(RewardResult)(data);
}, Effect.scoped);

function RewardStatus({ reward }: { reward: Reward | null }) {
  if (!reward) return null;
  return (
    <div role="status" className="flex flex-col gap-1 text-sm">
      <p>
        {reward.state === "applied"
          ? "Reward delivered."
          : reward.state === "issued"
            ? "Code ready to claim."
            : `${reward.state.charAt(0).toUpperCase()}${reward.state.slice(1)}.`}{" "}
        {reward.message}
      </p>
      {reward.state === "applied" && reward.endsAt && (
        <p>Pro reward ends {new Date(reward.endsAt).toLocaleString()}.</p>
      )}
      {reward.state === "issued" && (
        <p>Claim by {new Date(reward.claimBy).toLocaleString()}.</p>
      )}
    </div>
  );
}

/** Report grants stay account-specific. Shareable codes live in Pro codes. */
export function AdminProReward({
  reportId,
  reference,
  email,
}: {
  reportId: number;
  reference: string;
  email: string;
}) {
  const id = useId();
  const [bug, setBug] = useState(reference);
  const [reward, setReward] = useState<Reward | null>(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    const fiber = Effect.runFork(
      loadReward(reportId).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (!active) return;
            setReward(r.reward);
            setLoaded(true);
          },
          onFailure: () => {
            if (active)
              setError(
                "Couldn't load reward history. Refresh before issuing a reward.",
              );
          },
        }),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [reportId]);
  function act(action: "give" | "retry") {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    Effect.runFork(
      saveReward("/api/admin/pro-rewards", {
        reportId,
        bug,
        action,
      }).pipe(
        Effect.match({
          onSuccess: (r) => {
            setReward(r.reward);
            setReview(false);
          },
          onFailure: (error) => setError(error.message),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            saving.current = false;
            setBusy(false);
          }),
        ),
      ),
    );
  }
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-sm font-medium">
        Thank the bug reporter
      </h2>
      <p className="text-sm text-muted-foreground">
        Give {email} 30 extra days of Pro. No dollar credits or discounts. One
        reward per fixed bug and account. To thank someone outside this inbox,{" "}
        <Link to="/admin/pro-codes" className="underline underline-offset-4">
          generate a shareable code
        </Link>
        .
      </p>
      <RewardStatus reward={reward} />
      {(!reward || reward.state === "issued") && (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-bug`}>Fixed bug reference</FieldLabel>
            <Input
              id={`${id}-bug`}
              name="bug"
              value={bug}
              maxLength={120}
              disabled={busy || !!reward}
              onChange={(e) => setBug(e.target.value)}
              aria-describedby={`${id}-help`}
            />
            <FieldDescription id={`${id}-help`}>
              Use the same reference for duplicate reports of the same bug.
            </FieldDescription>
          </Field>
          {review ? (
            <form
              action="/api/admin/pro-rewards"
              method="post"
              aria-label="Confirm Pro reward"
              onSubmit={(e) => {
                e.preventDefault();
                void act("give");
              }}
            >
              <FieldGroup>
                <p className="text-sm">
                  Confirm 30 extra days. Free accounts get no-card, non-renewing
                  access. Subscribers keep their plan with a later renewal;
                  existing cancellations stay canceled. Uncertain billing stays
                  pending for review.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Confirm 30 days"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setReview(false)}
                  >
                    Back
                  </Button>
                </div>
              </FieldGroup>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!loaded || busy || !bug.trim()}
                onClick={() => setReview(true)}
              >
                Give 30 days of Pro
              </Button>
            </div>
          )}
        </>
      )}
      {reward && ["pending", "review", "scheduled"].includes(reward.state) && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={() => void act("retry")}
        >
          {busy ? "Checking…" : "Check or retry same reward"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

export function RedeemProReward({
  accountId,
  email,
}: {
  accountId: string;
  email: string;
}) {
  const id = useId();
  const { reload, state, plan, subs, giftEndsAt } = useMembership();
  const [openedAt] = useState(Date.now);
  const [code, setCode] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [formatError, setFormatError] = useState("");
  const [error, setError] = useState("");
  const [reward, setReward] = useState<Reward | null>(null);
  const normalized = code.replace(/\s/g, "");
  const subscriptions = subs.filter(
    (s) => !["canceled", "incomplete_expired"].includes(s.status),
  );
  const sub = subscriptions.length === 1 ? subscriptions[0] : undefined;
  const canceling = !!(sub?.cancelAtPeriodEnd || sub?.cancelAt);
  const trialing = sub?.status === "trialing";
  const coverage = sub
    ? Date.parse(
        (canceling ? sub.cancelAt : null) ??
          (trialing ? sub.trialEnd : sub.periodEnd) ??
          "",
      )
    : 0;
  const needsCheck =
    plan === "founding" ||
    subscriptions.length > 1 ||
    (sub &&
      (sub.plan !== "unlimited" ||
        !sub.stripeSubscriptionId ||
        !["active", "trialing"].includes(sub.status) ||
        !Number.isFinite(coverage) ||
        coverage <= openedAt));
  const startsAt = Math.max(
    openedAt,
    giftEndsAt ?? 0,
    Number.isFinite(coverage) ? coverage : 0,
  );
  const endsAt = startsAt + 30 * 86400_000;
  const date = (time: number) =>
    new Date(time).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });

  useEffect(() => {
    if (review || reward) headingRef.current?.focus();
  }, [review, reward]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function validate() {
    const valid = /^DF-[a-f0-9]{64}$/.test(normalized);
    setFormatError(valid ? "" : "Paste the whole code, starting with DF-.");
    return valid;
  }

  function claim() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    Effect.runFork(
      Effect.gen(function* () {
        const r = yield* saveReward("/api/membership/redeem", {
          code: normalized,
          accountId,
          consent: true,
        });
        if (!r.reward) {
          return yield* Effect.fail(
            new RewardRequestError({
              reason: "missingReward",
              message:
                "Couldn't confirm delivery. Retry the same code for this account.",
            }),
          );
        }
        setReward(r.reward);
        reload();
      }).pipe(
        Effect.catchTag("RewardRequestError", (error) =>
          Effect.sync(() => setError(error.message)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            saving.current = false;
            setBusy(false);
          }),
        ),
      ),
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col items-start gap-1">
        <p className="text-sm text-muted-foreground">Claiming for</p>
        <p className="max-w-full text-sm font-medium break-words">{email}</p>
        <Button
          type="button"
          variant="link"
          className="px-0"
          disabled={busy}
          onClick={() => signOutAndReload("/redeem")}
        >
          Switch account
        </Button>
      </div>
      {reward ? (
        <div className="flex flex-col gap-4">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-medium">
            {reward.state === "applied"
              ? "Your 30 days are ready"
              : reward.state === "scheduled"
                ? "Your 30 days are reserved"
                : "Your reward needs a check"}
          </h2>
          <RewardStatus reward={reward} />
          {reward.state === "scheduled" && reward.startsAt && reward.endsAt && (
            <p className="text-sm">
              Estimated gift: {date(reward.startsAt)} to {date(reward.endsAt)}.
              Billing stays canceled.
            </p>
          )}
          {["pending", "review"].includes(reward.state) && (
            <>
              <p className="text-sm text-muted-foreground">
                This code belongs to this account now. The extra time isn't
                confirmed yet. Check this same reward, or contact the person who
                sent it. Don't claim another code to repair it.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void claim()}
              >
                {busy ? "Checking…" : "Check same reward"}
              </Button>
            </>
          )}
          <a href="/settings" className="text-sm underline underline-offset-4">
            Go to Plan &amp; billing
          </a>
        </div>
      ) : (
        <form
          action="/api/membership/redeem"
          method="post"
          aria-labelledby={`${id}-title`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!validate()) {
              inputRef.current?.focus();
              return;
            }
            if (state !== "ready") return;
            if (review) void claim();
            else setReview(true);
          }}
        >
          <FieldGroup>
            <h2
              id={`${id}-title`}
              ref={headingRef}
              tabIndex={-1}
              className="text-lg font-medium"
            >
              {review ? "Review your 30 days" : "Enter your code"}
            </h2>
            {review ? (
              <>
                <div className="flex flex-col gap-3 text-sm">
                  {needsCheck ? (
                    <p>
                      Your membership needs a billing check. You can claim the
                      code for this account, but the reward may be held for
                      review instead of changing your plan.
                    </p>
                  ) : sub && !canceling ? (
                    <>
                      <p>
                        {trialing
                          ? "Estimated trial end"
                          : "Estimated next renewal"}
                        : <strong>{date(endsAt)}</strong> (was {date(coverage)}
                        ).
                      </p>
                      <p>
                        Your{" "}
                        {sub.billingInterval === "year"
                          ? "annual"
                          : sub.billingInterval === "month"
                            ? "monthly"
                            : "current"}{" "}
                        Pro plan stays the same. This reward adds no charge.
                        Your existing renewal or no-card expiry rules still
                        apply.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>
                        Estimated gift:{" "}
                        <strong>
                          {date(startsAt)} to {date(endsAt)}
                        </strong>
                        .
                      </p>
                      {!sub && giftEndsAt && giftEndsAt > openedAt ? (
                        <p>
                          These 30 days start after your existing gift ends.
                        </p>
                      ) : null}
                      <p>
                        {canceling
                          ? "Your gift starts after your current access ends. Billing stays canceled; this does not restart your subscription."
                          : "No card, subscription, or automatic renewal. When your gift ends, you return to Free unless you choose to subscribe."}
                      </p>
                    </>
                  )}
                  <p className="text-muted-foreground">
                    Dates are estimates in your local time. The server checks
                    your current account and billing before confirming delivery.
                    If anything needs a check, your reward is held for review.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setReview(false);
                    setError("");
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  Edit code
                </Button>
              </>
            ) : (
              <Field data-invalid={!!formatError}>
                <FieldLabel htmlFor={`${id}-code`}>
                  Pro code (required)
                </FieldLabel>
                <Input
                  ref={inputRef}
                  id={`${id}-code`}
                  name="code"
                  required
                  maxLength={100}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  value={code}
                  onBlur={() => {
                    if (code) validate();
                  }}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setFormatError("");
                    setError("");
                  }}
                  aria-invalid={!!formatError}
                  aria-describedby={`${id}-help${formatError ? ` ${id}-format` : ""}`}
                />
                <FieldDescription id={`${id}-help`}>
                  Paste the full code from your message. Each code can be
                  claimed by one verified account within 90 days of issue.
                </FieldDescription>
                {formatError && (
                  <p
                    id={`${id}-format`}
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {formatError}
                  </p>
                )}
              </Field>
            )}
            <Button type="submit" disabled={busy || state !== "ready"}>
              {busy
                ? "Confirming your reward…"
                : state === "loading"
                  ? "Loading your plan…"
                  : review
                    ? "Claim 30 days of Pro"
                    : "Review gift"}
            </Button>
            {state === "error" && (
              <p role="alert" className="text-sm">
                Couldn't load your plan.{" "}
                <button
                  type="button"
                  className="underline underline-offset-4"
                  onClick={reload}
                >
                  Try again
                </button>
                .
              </p>
            )}
          </FieldGroup>
        </form>
      )}
      {error && (
        <div className="flex flex-col gap-2 text-sm">
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="text-destructive"
          >
            {error}
          </p>
          <p className="text-muted-foreground">
            Check that you pasted the whole code. If a request was interrupted,
            it may already have claimed the code. Retry this same code for this
            account when available. If you're stuck, contact the person who sent
            it.
          </p>
        </div>
      )}
    </section>
  );
}
