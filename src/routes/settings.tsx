import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  FileUpIcon,
  Link2Icon,
  Loader2Icon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlugZapIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DeleteAccountDialog } from "../components/delete-account-dialog";
import { McpConnectDialog } from "../components/mcp-connect-dialog";
import { openOpmlImport } from "../components/opml-import-opener";
import { useTextSize, type TextSize } from "../components/text-size-provider";
import { useTheme } from "../components/theme-provider";
import { Button } from "../components/ui/button";
import { localDateKey } from "../data/date-links";
import { downloadTextFile } from "../data/download";
import { outlineToMarkdown } from "../data/markdown";
import { useNodeCount } from "../data/node-count";
import { exportOpml } from "../data/opml-export";
import { FREE_NODE_LIMIT, PLAN_LABELS, type PlanName } from "../data/plans";
import { childrenOf } from "../data/tree";
import { getTreeIndex } from "../data/tree-store";
import {
  connectGoogle,
  signOutAndReload,
  subscription,
  useSession,
} from "../lib/auth-client";
import { cn } from "../lib/utils";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

// --- Whole-outline data actions ----------------------------------------------
// On /settings there is NO zoom view, so these are explicit WHOLE-outline
// operations (rootId = null), unlike the header More menu's contextual variants
// that read `getViewRootId()`.

async function copyWholeOutlineMarkdown() {
  const index = getTreeIndex();
  const rootIds = childrenOf(index, null).map((n) => n.id);
  const markdown = outlineToMarkdown(index, rootIds);
  if (!markdown) {
    toast("Nothing to copy yet");
    return;
  }
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success("Copied as Markdown");
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

function exportWholeOutlineOpml() {
  const index = getTreeIndex();
  if (childrenOf(index, null).length === 0) {
    toast("Nothing to export yet");
    return;
  }
  const opml = exportOpml(index, null, { title: "dotflowy export" });
  downloadTextFile(
    `dotflowy-export-${localDateKey()}.opml`,
    "text/x-opml;charset=utf-8",
    opml,
  );
}

// --- Small presentational primitives -----------------------------------------

/** A titled section: a quiet uppercase-ish label, optional caption, then body. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/** A bordered container that stacks {@link SettingRow}s with divider lines. */
function RowGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-foreground/10">
      {children}
    </div>
  );
}

/** One label/description on the left, an action control on the right. */
function SettingRow({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 bg-card px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && (
            <div className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

/** A radio-style segmented control (theme, text size). */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[0.8rem] font-medium transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5",
              active
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Plan & billing ----------------------------------------------------------

interface SubRow {
  plan: string;
  status: string;
  cancelAtPeriodEnd?: boolean;
  periodEnd?: string | Date;
}

/** Active/trialing rows resolve the plan (founding outranks unlimited), mirroring
 *  worker/plan.ts `resolvePlan` — kept simple + local so the client never imports
 *  worker code. */
function resolvePlanFromSubs(subs: SubRow[]): PlanName {
  let plan: PlanName = "free";
  for (const s of subs) {
    if (s.status !== "active" && s.status !== "trialing") continue;
    if (s.plan === "founding") return "founding";
    if (s.plan === "unlimited") plan = "unlimited";
  }
  return plan;
}

function activeSub(subs: SubRow[]): SubRow | null {
  return (
    subs.find(
      (s) =>
        (s.status === "active" || s.status === "trialing") &&
        (s.plan === "unlimited" || s.plan === "founding"),
    ) ?? null
  );
}

type SubState = "loading" | "error" | "ready";

interface Subscriptions {
  state: SubState;
  subs: SubRow[];
  reload: () => void;
}

/** ONE `subscription.list()` fetch for the whole page (both Plan & billing and
 *  the Connections nudge read it) — lifted to SettingsPage so the endpoint isn't
 *  hit twice on mount, and the two sections can't disagree about the plan. */
function useSubscriptions(): Subscriptions {
  const [state, setState] = useState<SubState>("loading");
  const [subs, setSubs] = useState<SubRow[]>([]);

  const reload = useCallback(() => {
    let cancelled = false;
    setState("loading");
    subscription.list().then(
      ({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setState("error");
          return;
        }
        setSubs((data ?? []) as SubRow[]);
        setState("ready");
      },
      () => {
        if (!cancelled) setState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  return { state, subs, reload };
}

function UsageMeter() {
  const { count, ready } = useNodeCount();
  const pct = Math.min(100, Math.round((count / FREE_NODE_LIMIT) * 100));
  const near = pct >= 80;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">Nodes used</span>
        <span
          className={cn(
            "font-medium tabular-nums",
            ready ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {ready ? count.toLocaleString() : "—"} of{" "}
          {FREE_NODE_LIMIT.toLocaleString()}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            near ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: ready ? `${pct}%` : "0%" }}
        />
      </div>
    </div>
  );
}

/** One upgrade card: a headline price, a supporting line, and a single primary
 *  action. `featured` gives the founding card a subtle ring. */
function UpgradeCard({
  name,
  price,
  cadence,
  note,
  cta,
  onUpgrade,
  featured,
  busy,
}: {
  name: string;
  price: string;
  cadence: string;
  note: ReactNode;
  cta: string;
  onUpgrade: () => void;
  featured?: boolean;
  busy: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-4 ring-1",
        featured ? "ring-primary/40" : "ring-foreground/10",
      )}
    >
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{name}</span>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-semibold tracking-tight text-foreground">
            {price}
          </span>
          <span className="text-sm text-muted-foreground">{cadence}</span>
        </div>
      </div>
      <p className="flex-1 text-sm text-muted-foreground">{note}</p>
      <Button
        variant={featured ? "default" : "outline"}
        onClick={onUpgrade}
        disabled={busy}
      >
        {busy && <Loader2Icon className="animate-spin" />}
        {cta}
      </Button>
    </div>
  );
}

function PlanBilling({ state, subs, reload }: Subscriptions) {
  const [busy, setBusy] = useState(false);

  async function upgrade(plan: "unlimited" | "founding", annual: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      // On success the client REDIRECTS to Stripe Checkout, so the page unloads
      // and `busy` never needs resetting on the happy path. Only a returned
      // error (e.g. the founding 50-seat 403) lands back here.
      const { error } = await subscription.upgrade({
        plan,
        annual,
        successUrl: "/settings",
        cancelUrl: "/settings",
      });
      if (error) {
        toast.error(
          error.message ??
            (plan === "founding"
              ? "Founding is sold out."
              : "Couldn't start checkout. Please try again."),
        );
        setBusy(false);
      }
    } catch {
      toast.error("Couldn't start checkout. Please try again.");
      setBusy(false);
    }
  }

  async function manageBilling() {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await subscription.billingPortal({
        returnUrl: "/settings",
      });
      if (error) {
        toast.error("Couldn't open the billing portal. Please try again.");
        setBusy(false);
      }
    } catch {
      toast.error("Couldn't open the billing portal. Please try again.");
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await subscription.cancel({ returnUrl: "/settings" });
      if (error) {
        toast.error("Couldn't start cancellation. Please try again.");
        setBusy(false);
      }
    } catch {
      toast.error("Couldn't start cancellation. Please try again.");
      setBusy(false);
    }
  }

  if (state === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-card px-4 py-6 text-sm text-muted-foreground ring-1 ring-foreground/10">
        <Loader2Icon className="size-4 animate-spin" />
        Loading your plan…
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl bg-card px-4 py-5 text-sm ring-1 ring-foreground/10">
        <p className="text-muted-foreground">
          We couldn't load your plan right now.
        </p>
        <Button variant="outline" size="sm" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  }

  const plan = resolvePlanFromSubs(subs);
  const paid = plan !== "free";
  const sub = activeSub(subs);

  return (
    <div className="flex flex-col gap-4">
      {/* Current plan card */}
      <div className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">
              Current plan
            </span>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-foreground">
                {PLAN_LABELS[plan]}
              </span>
              {paid && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[0.7rem] font-medium text-primary">
                  <CheckIcon className="size-3" />
                  Active
                </span>
              )}
            </div>
            {plan === "founding" && (
              <span className="text-sm text-muted-foreground">
                3-year founding term
              </span>
            )}
            {paid && sub?.cancelAtPeriodEnd && (
              <span className="text-sm text-amber-600 dark:text-amber-500">
                Cancels at the end of the current period
              </span>
            )}
          </div>
          {paid && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void manageBilling()}
              disabled={busy}
            >
              {busy && <Loader2Icon className="animate-spin" />}
              Manage billing
            </Button>
          )}
        </div>

        {plan === "free" && <UsageMeter />}

        {paid && (
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={busy}
            className="self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
          >
            Cancel subscription
          </button>
        )}
      </div>

      {/* Upgrade options — free tier only */}
      {plan === "free" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <UpgradeCard
            name="Unlimited"
            price="$5"
            cadence="/ month"
            note={
              <>
                No node limit, plus AI app connections over MCP. Or{" "}
                <span className="font-medium text-foreground">
                  $48/yr ($4/mo billed yearly)
                </span>
                .
              </>
            }
            cta="Upgrade monthly"
            onUpgrade={() => void upgrade("unlimited", false)}
            busy={busy}
          />
          <UpgradeCard
            name="Unlimited, yearly"
            price="$48"
            cadence="/ year"
            note="Everything in Unlimited, billed once a year — that's $4/mo."
            cta="Upgrade yearly"
            onUpgrade={() => void upgrade("unlimited", true)}
            busy={busy}
          />
          <div className="sm:col-span-2">
            <UpgradeCard
              name="Founding"
              price="$99"
              cadence="/ 3 years"
              featured
              note={
                <>
                  Support Dotflowy early and lock in three years. Limited to 50
                  seats.{" "}
                  <span className="text-foreground">
                    Renews after 3 years unless you cancel — cancel anytime.
                  </span>
                </>
              }
              cta="Become a founding member"
              onUpgrade={() => void upgrade("founding", false)}
              busy={busy}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// --- Sections ----------------------------------------------------------------

function AccountSection() {
  const { data: session } = useSession();
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <Section title="Account">
      <RowGroup>
        <SettingRow
          title="Signed in"
          description={session?.user.email ?? "…"}
          action={null}
        />
        <SettingRow
          title="Connect Google"
          description="Add Google sign-in to this account."
          action={
            <Button variant="outline" size="sm" onClick={() => connectGoogle()}>
              <Link2Icon />
              Connect
            </Button>
          }
        />
        <SettingRow
          title="Sign out"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => signOutAndReload()}
            >
              <LogOutIcon />
              Sign out
            </Button>
          }
        />
        <SettingRow
          title="Delete account"
          description="Permanently delete your outline and account."
          action={
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2Icon />
              Delete
            </Button>
          }
        />
      </RowGroup>
      <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
    </Section>
  );
}

/** `plan` is null until the shared subscription fetch resolves (or if it failed);
 *  the free-tier nudge only shows once we KNOW the account is free. */
function ConnectionsSection({ plan }: { plan: PlanName | null }) {
  const [connectOpen, setConnectOpen] = useState(false);
  const free = plan === "free";

  return (
    <Section
      title="Connections"
      description="Read and edit your outline from AI apps over MCP — no API key, you just sign in."
    >
      <RowGroup>
        <SettingRow
          icon={<PlugZapIcon />}
          title="Connect apps (MCP)"
          description="Claude, Cursor, VS Code, ChatGPT, and more."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConnectOpen(true)}
            >
              Set up
            </Button>
          }
        />
      </RowGroup>
      {free && (
        <p className="text-sm text-muted-foreground">
          Connecting AI apps requires{" "}
          <span className="font-medium text-foreground">Unlimited</span>. See
          plan &amp; billing above to upgrade.
        </p>
      )}
      <McpConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </Section>
  );
}

function DataSection() {
  return (
    <Section
      title="Data"
      description="Your whole outline — export it or bring one in. These act on everything, not just the current view."
    >
      <RowGroup>
        <SettingRow
          icon={<FileUpIcon />}
          title="Import OPML"
          description="Bring in a Workflowy (or other) OPML export."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => openOpmlImport()}
            >
              Import…
            </Button>
          }
        />
        <SettingRow
          icon={<DownloadIcon />}
          title="Export OPML"
          description="Download your entire outline as an OPML file."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={exportWholeOutlineOpml}
            >
              Export
            </Button>
          }
        />
        <SettingRow
          icon={<ClipboardCopyIcon />}
          title="Copy as Markdown"
          description="Copy your entire outline as a markdown list."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyWholeOutlineMarkdown()}
            >
              Copy
            </Button>
          }
        />
      </RowGroup>
    </Section>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { textSize, setTextSize } = useTextSize();
  return (
    <Section title="Appearance">
      <RowGroup>
        <SettingRow
          title="Theme"
          action={
            <Segmented
              label="Theme"
              value={theme}
              onChange={(v) => setTheme(v)}
              options={[
                { value: "light", label: <SunIcon />, title: "Light" },
                { value: "dark", label: <MoonIcon />, title: "Dark" },
                { value: "system", label: <MonitorIcon />, title: "System" },
              ]}
            />
          }
        />
        <SettingRow
          title="Text size"
          action={
            <Segmented
              label="Text size"
              value={textSize}
              onChange={(v: TextSize) => setTextSize(v)}
              options={[
                { value: "small", label: "Small" },
                { value: "default", label: "Default" },
                { value: "large", label: "Large" },
              ]}
            />
          }
        />
      </RowGroup>
    </Section>
  );
}

function SettingsPage() {
  // One subscription fetch for the whole page; Plan & billing and the
  // Connections nudge both read it (no double request, no divergent state).
  const subscriptions = useSubscriptions();
  const plan =
    subscriptions.state === "ready"
      ? resolvePlanFromSubs(subscriptions.subs)
      : null;

  return (
    <main className="min-h-dvh bg-background">
      {/* Minimal page header: back to the outline + title. The outline's own
          header (Header.tsx) doesn't render on this route, so /settings carries
          its own chrome. */}
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            nativeButton={false}
            render={<Link to="/" />}
            aria-label="Back to outline"
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="text-base font-semibold text-foreground">Settings</h1>
        </div>
      </header>

      <div className="mx-auto flex max-w-2xl flex-col gap-10 px-4 py-8 sm:px-6">
        <Section
          title="Plan & billing"
          description="Your plan, usage, and payment."
        >
          <PlanBilling {...subscriptions} />
        </Section>

        <AccountSection />
        <ConnectionsSection plan={plan} />
        <DataSection />
        <AppearanceSection />
      </div>
    </main>
  );
}
