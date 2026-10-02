import { createFileRoute, Link } from "@tanstack/react-router";
import { Effect, Fiber, Schema } from "effect";
import { useEffect, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { buttonVariants } from "../components/ui/button-variants";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Skeleton } from "../components/ui/skeleton";
import {
  AdminAnalyticsReport,
  ExperimentalStorageReport,
  type AnalyticsUser,
} from "../data/admin-analytics-schema";

export const Route = createFileRoute("/admin/analytics")({
  component: AdminAnalytics,
});

class AnalyticsRequestError extends Schema.TaggedError<AnalyticsRequestError>()(
  "AnalyticsRequestError",
  { status: Schema.NullOr(Schema.Number) },
) {}

/** Same-origin adapter. No error payloads or user data go to monitoring. */
const fetchReport = Effect.fn("AdminAnalytics.fetch")(function* <A>(
  url: string,
  schema: Schema.Decoder<A>,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { signal, cache: "no-store" }),
    catch: () => new AnalyticsRequestError({ status: null }),
  });
  if (!response.ok)
    return yield* Effect.fail(
      new AnalyticsRequestError({ status: response.status }),
    );
  const raw = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new AnalyticsRequestError({ status: null }),
  });
  return yield* Schema.decodeUnknownEffect(schema)(raw);
}, Effect.timeout("25 seconds"));

function date(at: number | null): string {
  return at === null
    ? "Unknown"
    : new Date(at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function Metric({
  title,
  value,
  description,
}: {
  title: string;
  value: number | string;
  description: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardFooter>
    </Card>
  );
}

function ExperimentalStorage({ user }: { user: AnalyticsUser }) {
  const [result, setResult] = useState<ExperimentalStorageReport | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  function inspect() {
    setState("loading");
    setResult(null);
    void Effect.runPromise(
      fetchReport(
        `/api/admin/analytics/storage?userId=${encodeURIComponent(user.id)}`,
        ExperimentalStorageReport,
      ).pipe(
        Effect.tap((data) =>
          Effect.sync(() => {
            setResult(data);
            setState("ready");
          }),
        ),
        Effect.catch(() => Effect.sync(() => setState("error"))),
      ),
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {state === "idle" && (
        <span className="text-muted-foreground">Not inspected</span>
      )}
      {state === "loading" && <span role="status">Inspecting…</span>}
      {(state === "error" || (state === "ready" && !result?.metadata)) && (
        <span className="text-muted-foreground">Unknown, read failed</span>
      )}
      {result?.metadata && (
        <>
          <span>{result.metadata.nodeCount.toLocaleString()} nodes</span>
          <span className="text-xs text-muted-foreground">
            Node import: {date(result.metadata.nodesMigratedAt)}
          </span>
          <span className="text-xs text-muted-foreground">
            Side-data import: {date(result.metadata.kvMigratedAt)}
          </span>
          <span className="text-xs text-muted-foreground">
            Checked {date(result.checkedAt)}
          </span>
        </>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={state === "loading"}
        aria-label={`Inspect experimental storage for ${user.email}`}
        onClick={inspect}
      >
        {state === "idle" ? "Inspect storage" : "Inspect again"}
      </Button>
    </div>
  );
}

const PREFERENCE_LABELS = {
  enabled: "On",
  disabled: "Off",
  unset: "Not set",
  unknown: "Unknown",
} as const;

function AdminAnalytics() {
  const [report, setReport] = useState<AdminAnalyticsReport | null>(null);
  const [state, setState] = useState<"loading" | "denied" | "error" | "ready">(
    "loading",
  );
  const [includeOwner, setIncludeOwner] = useState(false);
  const [cursors, setCursors] = useState([""]);
  const [refresh, setRefresh] = useState(0);
  const after = cursors.at(-1) ?? "";

  useEffect(() => {
    setState("loading");
    setReport(null);
    const query = new URLSearchParams({
      after,
      includeOwner: String(includeOwner),
    });
    const fiber = Effect.runFork(
      fetchReport(`/api/admin/analytics?${query}`, AdminAnalyticsReport).pipe(
        Effect.tap((data) =>
          Effect.sync(() => {
            setReport(data);
            setState("ready");
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            setState(
              error._tag === "AnalyticsRequestError" &&
                (error.status === 404 || error.status === 401)
                ? "denied"
                : "error",
            ),
          ),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [after, includeOwner, refresh]);

  if (state === "denied")
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Not found.</p>
      </main>
    );

  const pageUsers =
    report?.users.filter((u) => report.includeOwner || !u.isOwner) ?? [];
  const on = pageUsers.filter(
    (u) => u.experimentalPreference === "enabled",
  ).length;
  const off = pageUsers.filter(
    (u) => u.experimentalPreference === "disabled",
  ).length;
  const unset = pageUsers.filter(
    (u) => u.experimentalPreference === "unset",
  ).length;
  const unknown = pageUsers.filter(
    (u) => u.experimentalPreference === "unknown",
  ).length;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-sm text-muted-foreground">Admin</p>
          <h1 className="text-2xl font-semibold">Usage overview</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Accounts, preferences, and stored data. Activity is not yet
            measured.
          </p>
        </div>
        <nav aria-label="Admin navigation" className="flex flex-wrap gap-2">
          <Link
            to="/admin/waitlist"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Waitlist
          </Link>
          <Link
            to="/"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Back to outline
          </Link>
        </nav>
      </header>

      {state === "loading" && (
        <div
          role="status"
          aria-label="Loading usage overview"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-36" />
          ))}
        </div>
      )}
      {state === "error" && (
        <Card>
          <CardHeader>
            <CardTitle>Could not load the report</CardTitle>
            <CardDescription>
              No data was displayed. This is not evidence of zero users.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
              Try again
            </Button>
          </CardFooter>
        </Card>
      )}

      {report && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted-foreground">
              {report.population.toLocaleString()} accounts in D1 · Checked{" "}
              {new Date(report.generatedAt).toLocaleString()}
            </p>
            <label className="flex cursor-pointer items-center gap-2 py-2">
              <Checkbox
                checked={includeOwner}
                onCheckedChange={setIncludeOwner}
                disabled={!report.ownerConfigured}
              />
              Include owner in totals
            </label>
          </div>
          {!report.ownerConfigured && (
            <p className="text-sm text-muted-foreground">
              Owner identity is not configured. Totals include every account.
            </p>
          )}
          <section
            aria-label="Account totals"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Metric
              title="Registered users"
              value={report.summary.registered}
              description={
                report.includeOwner || !report.ownerConfigured
                  ? "All accounts"
                  : "Owner excluded from totals"
              }
            />
            <Metric
              title="Joined in 7 days"
              value={report.summary.joined7d}
              description={`${report.summary.joined30d} joined in 30 days`}
            />
            <Metric
              title="Session created in 7 days"
              value={report.summary.retainedSession7d}
              description={`${report.summary.retainedSession30d} accounts in 30 days · retained rows only`}
            />
            <Metric
              title="Experimental preference on"
              value={on}
              description={`Of ${pageUsers.length} accounts on this page · not active use`}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>
                Collection is not installed. Unknown does not mean inactive.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-3">
                {["Opened outline", "Browser edits", "MCP edits"].map(
                  (label) => (
                    <div key={label}>
                      <dt className="text-sm text-muted-foreground">
                        {label}, 7 / 30 days
                      </dt>
                      <dd className="mt-1 font-medium">Not measured</dd>
                    </div>
                  ),
                )}
              </dl>
            </CardContent>
            <CardFooter>
              <p className="text-xs text-muted-foreground">
                Activity reporting requires a published privacy update, an
                in-app notice, and an account choice before collection. No
                outline text is needed.
              </p>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
              <CardDescription>
                Saved experimental preferences on this page: {on} on, {off} off,{" "}
                {unset} not set, {unknown} unknown.
                {report.ownerConfigured &&
                  !report.includeOwner &&
                  " Owner excluded from these preference totals, but shown below."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-xs text-muted-foreground">
                Browser and MCP use classic sync. Saved experimental preferences
                are retained metadata, not a current backend choice. Counts can
                include seeded or imported data and do not prove recent use.
                Inspecting experimental storage can initialize an empty shard.
              </p>
              <p className="mb-3 text-xs text-muted-foreground lg:hidden">
                Scroll sideways to see all user columns.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-left text-sm">
                  <caption className="sr-only">
                    Registered users and content-free storage metadata
                  </caption>
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      {[
                        "User",
                        "Joined",
                        "Last session created",
                        "Experimental preference",
                        "Classic storage",
                        "Experimental storage",
                      ].map((label) => (
                        <th
                          key={label}
                          scope="col"
                          className="px-3 py-3 font-medium first:pl-0"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.users.map((user) => (
                      <tr
                        key={user.id}
                        className="border-b border-border/50 align-top"
                      >
                        <th
                          scope="row"
                          className="max-w-64 py-4 pr-3 font-normal"
                        >
                          <p className="font-medium break-all">{user.email}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {user.name}
                          </p>
                          <p className="mt-1 text-xs break-all text-muted-foreground">
                            {user.id}
                          </p>
                          <div className="mt-2 flex gap-2">
                            {user.isOwner && (
                              <Badge variant="secondary">Owner</Badge>
                            )}
                            {!user.emailVerified && (
                              <Badge variant="outline">Unverified</Badge>
                            )}
                          </div>
                        </th>
                        <td className="px-3 py-4 whitespace-nowrap">
                          {date(user.createdAt)}
                        </td>
                        <td className="px-3 py-4">
                          {user.lastSessionCreatedAt === null
                            ? "No retained session"
                            : date(user.lastSessionCreatedAt)}
                        </td>
                        <td className="px-3 py-4">
                          <Badge
                            variant={
                              user.experimentalPreference === "enabled"
                                ? "secondary"
                                : "outline"
                            }
                          >
                            {PREFERENCE_LABELS[user.experimentalPreference]}
                          </Badge>
                        </td>
                        <td className="px-3 py-4">
                          {user.classicNodeCount === null
                            ? "Unknown, read failed"
                            : `${user.classicNodeCount.toLocaleString()} nodes`}
                        </td>
                        <td className="px-3 py-4">
                          <ExperimentalStorage
                            key={`${report.generatedAt}:${user.id}`}
                            user={user}
                          />
                        </td>
                      </tr>
                    ))}
                    {report.users.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-8 text-muted-foreground">
                          No users on this page.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
            <CardFooter className="flex-wrap justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Page {cursors.length} · {report.users.length} users · Session
                history can expire or be deleted. It is not outline activity.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors((values) => values.slice(0, -1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={report.nextCursor === null}
                  onClick={() => {
                    const next = report.nextCursor;
                    if (next !== null)
                      setCursors((values) => [...values, next]);
                  }}
                >
                  Next
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRefresh((n) => n + 1)}
                >
                  Refresh
                </Button>
              </div>
            </CardFooter>
          </Card>
        </>
      )}
    </main>
  );
}
