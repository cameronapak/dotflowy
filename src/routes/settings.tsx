import {
  createFileRoute,
  Link,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { Effect } from "effect";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  FileUploadIcon,
  LinkIcon,
  LoaderIcon,
  LogoutIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  SmartphoneIcon,
  SunIcon,
  TerminalIcon,
  TrashIcon,
} from "@/lib/icons";

import { openAppleShortcut } from "../components/apple-shortcut-opener";
import { ApiKeysSettings } from "../components/capture-keys-dialog";
import { CliSetupDialog } from "../components/cli-setup-dialog";
import {
  COLOR_THEMES,
  colorThemeLabel,
  isCustomTheme,
  customThemeToReopen,
  setColorTheme,
  useColorTheme,
  endColorThemePreview,
  useColorThemePreview,
  type ColorThemeId,
} from "../components/color-theme";
import { CustomThemePicker } from "../components/custom-theme-picker";
import { DeleteAccountDialog } from "../components/delete-account-dialog";
import { McpConnectDialog } from "../components/mcp-connect-dialog";
import { McpConnections } from "../components/mcp-connections";
import { openMembership } from "../components/membership-opener";
import { openOpmlImport } from "../components/opml-import-opener";
import { ProTrialOffer } from "../components/pro-trial-offer";
import {
  SettingsOptionRow,
  SettingsSwitchTarget,
} from "../components/settings-option-row";
import { useTextSize, type TextSize } from "../components/text-size-provider";
import { useTheme } from "../components/theme-provider";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../components/ui/accordion";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuSeparator,
  ResponsiveMenuTrigger,
} from "../components/ui/responsive-menu";
import { Switch } from "../components/ui/switch";
import { parseCustomTheme, seedColor } from "../data/custom-theme";
import {
  retryEditorFeatures,
  setAppearanceToggle,
  setDailyToggle,
  setEditorFeature,
  setEmptyDaysMode,
  setExternalEmbeds,
  setWeekStart,
  useEditorFeatures,
  type AppearanceToggle,
  type DailyToggle,
  type EditorFeature,
  type EmptyDaysMode,
} from "../data/editor-features";
import { startCheckout, useMembership } from "../data/membership";
import { useNodeCount } from "../data/node-count";
import {
  copyOutlineAsMarkdown,
  exportOutlineAsOpml,
} from "../data/outline-actions";
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
import { FocusSettings } from "../plugins/focus/settings";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

async function copyWholeOutlineMarkdown() {
  if (childrenOf(getTreeIndex(), null).length === 0) {
    toast("Nothing to copy yet");
    return;
  }
  await copyOutlineAsMarkdown(null);
}

function exportWholeOutlineOpml() {
  const index = getTreeIndex();
  if (childrenOf(index, null).length === 0) {
    toast("Nothing to export yet");
    return;
  }
  exportOutlineAsOpml(null);
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
    <div className="flex flex-wrap items-center justify-between gap-4 bg-card px-4 py-3 sm:flex-nowrap">
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
      <div className="ml-auto shrink-0">{action}</div>
    </div>
  );
}

/** A radio-style segmented control (theme, text size, plugin options). */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  label: string;
  disabled?: boolean;
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
            disabled={disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[0.8rem] font-medium transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5",
              active
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-60",
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
  periodEnd?: string | Date | null;
  cancelAt?: string | null;
  billingInterval?: string | null;
  rewarded?: boolean;
  stripeSubscriptionId?: string | null;
  trialEnd?: string | null;
}

function activeSub(subs: readonly SubRow[]): SubRow | null {
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
  plan: PlanName | null;
  state: SubState;
  subs: readonly SubRow[];
  reload: () => void;
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
        {busy && <LoaderIcon className="animate-spin" />}
        {cta}
      </Button>
    </div>
  );
}

function PlanBilling({ state, subs, reload, plan }: Subscriptions) {
  const [busy, setBusy] = useState(false);
  const { giftEndsAt, rewardMessage } = useMembership();

  async function upgrade(plan: "unlimited" | "founding", annual: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      // On success the client REDIRECTS to Stripe Checkout, so the page unloads
      // and `busy` never needs resetting on the happy path. Only a returned
      // error (e.g. the founding 50-seat 403) lands back here.
      await startCheckout(plan, annual);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't start checkout. Please try again.",
      );
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
      const { error } = await subscription.cancel({
        returnUrl: "/settings",
        subscriptionId: activeSub(subs)?.stripeSubscriptionId ?? undefined,
      });
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
        <LoaderIcon className="size-4 animate-spin" />
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

  if (plan === null) return null;
  const paid = plan !== "free";
  const sub = activeSub(subs);
  const trialing = sub?.status === "trialing";

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
                <Badge variant="secondary">
                  <CheckIcon data-icon="inline-start" />
                  {giftEndsAt && !sub
                    ? "Thank-you gift"
                    : trialing
                      ? sub.rewarded
                        ? "Thank-you reward"
                        : "Pro trial"
                      : "Active"}
                </Badge>
              )}
            </div>
            {plan === "founding" && (
              <span className="text-sm text-muted-foreground">
                3-year founding term
              </span>
            )}
            {giftEndsAt && !sub && (
              <p className="text-sm text-muted-foreground">
                Pro is a gift until {new Date(giftEndsAt).toLocaleString()}. No
                card, subscription or automatic renewal. Afterward you return to
                Free; your outline stays saved.
              </p>
            )}
            {rewardMessage && (
              <p className="text-sm text-muted-foreground">{rewardMessage}</p>
            )}
            {trialing && !sub.rewarded && sub.trialEnd && (
              <p className="text-sm text-muted-foreground">
                Trial ends {new Date(sub.trialEnd).toLocaleString()}. Without a
                payment method, you return to Free. Add a payment method to
                continue Pro at $5/month.
              </p>
            )}
            {trialing && sub.rewarded && sub.trialEnd && (
              <p className="text-sm text-muted-foreground">
                Thank you for helping fix Dotflowy. Your 30 extra days are
                included.{" "}
                {sub.cancelAt || sub.cancelAtPeriodEnd
                  ? "Billing stays canceled."
                  : `Your existing ${sub.billingInterval === "year" ? "yearly" : "monthly"} plan's next billing date is ${new Date(sub.trialEnd).toLocaleString()}, unless you cancel. A cardless trial still ends without renewal if you do not add a payment method. Stripe may label this extra time as a trial.`}
              </p>
            )}
            {paid && (sub?.cancelAtPeriodEnd || sub?.cancelAt) && (
              <span className="text-sm text-amber-600 dark:text-amber-500">
                {sub.cancelAt
                  ? `Cancels ${new Date(sub.cancelAt).toLocaleString()}`
                  : "Cancels at the end of the current period"}
              </span>
            )}
          </div>
          {paid && sub?.stripeSubscriptionId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void manageBilling()}
              disabled={busy}
            >
              {busy && <LoaderIcon className="animate-spin" />}
              {trialing && !sub.rewarded ? "Continue Pro" : "Manage billing"}
            </Button>
          )}
        </div>

        {plan === "free" && <UsageMeter />}

        {paid &&
          sub?.stripeSubscriptionId &&
          !sub.cancelAt &&
          !sub.cancelAtPeriodEnd && (
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

      <a
        href="/redeem"
        className="self-start text-sm underline underline-offset-4"
      >
        Redeem code
      </a>
      {plan === "free" && <ProTrialOffer />}
      {giftEndsAt && !sub && (
        <p className="text-sm text-muted-foreground">
          Subscribing to Pro is optional. Checkout carries your remaining gift
          time forward, then your chosen plan renews unless you cancel.
        </p>
      )}

      {/* A gift is not a subscription. Deliberate Pro checkout preserves its time. */}
      {(plan === "free" || (giftEndsAt && !sub)) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <UpgradeCard
            name="Pro"
            price="$5"
            cadence="/ month"
            note={
              <>
                Every theme, AI app connections, member feedback, and no node
                limit. Or{" "}
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
            name="Pro, yearly"
            price="$48"
            cadence="/ year"
            note="Everything in Pro, billed once a year — that's $4/mo."
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
              <LinkIcon />
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
              <LogoutIcon />
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
              <TrashIcon />
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
  const [cliOpen, setCliOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const free = plan === "free";
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState<string[]>(() =>
    hash === "authorized-apps" || hash === "capture-keys" ? ["access"] : [],
  );
  const router = useRouter();
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ toLocation }) => {
        if (
          toLocation.pathname === "/settings" &&
          (toLocation.hash === "authorized-apps" ||
            toLocation.hash === "capture-keys")
        ) {
          setOpen((current) => [...new Set([...current, "access"])]);
        }
      }),
    [router],
  );

  return (
    <Section
      title="Connections"
      description="Use your outline from other apps, your terminal, or scripts."
    >
      <Accordion
        multiple
        value={open}
        onValueChange={(value) => setOpen(value.map(String))}
        className="gap-4"
      >
        <AccordionItem
          value="setup"
          className="overflow-hidden rounded-xl border-0 ring-1 ring-foreground/10"
        >
          <AccordionTrigger
            aria-label="Set up connections"
            className="group items-center gap-3 rounded-none bg-card px-4 py-3 hover:no-underline focus-visible:ring-inset"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>Set up</span>
              <span className="text-sm font-normal text-muted-foreground">
                Connect a new app, terminal, or shortcut.
              </span>
            </span>
            <span
              aria-hidden="true"
              className="text-xs font-normal text-muted-foreground"
            >
              {open.includes("setup") ? "Collapse" : "Expand"}
            </span>
          </AccordionTrigger>
          <AccordionContent className="divide-y divide-border border-t pb-0">
            <SettingRow
              icon={<PlugIcon />}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Connect apps (MCP)
                  <Badge variant="secondary">
                    {plan && !free
                      ? "Included with your subscription"
                      : "Included with Pro"}
                  </Badge>
                </span>
              }
              description="Let Claude, Cursor, VS Code, ChatGPT, and more work with your outline."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={plan === null}
                  onClick={() =>
                    free ? openMembership("connections") : setConnectOpen(true)
                  }
                >
                  {free ? "Unlock app connections" : "Set up"}
                </Button>
              }
            />
            <SettingRow
              icon={<TerminalIcon />}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Command line (CLI)
                  <Badge variant="secondary">
                    {plan && !free
                      ? "Included with your subscription"
                      : "Included with Pro"}
                  </Badge>
                </span>
              }
              description="Use Dotflowy from your terminal or scripts."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={
                    free
                      ? "Unlock command line (CLI)"
                      : "Set up command line (CLI)"
                  }
                  disabled={plan === null}
                  onClick={() =>
                    free ? openMembership("connections") : setCliOpen(true)
                  }
                >
                  {free ? "See plans" : "Set up"}
                </Button>
              }
            />
            <SettingRow
              icon={<SmartphoneIcon />}
              title="Apple Shortcut"
              description="Send text and links from other apps to today's note with the share sheet on iPhone or Mac. Available on every plan."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Set up Apple Shortcut"
                  onClick={openAppleShortcut}
                >
                  Set up
                </Button>
              }
            />
            {free && (
              <p className="bg-card px-4 py-3 text-sm text-muted-foreground">
                App connections and the CLI are included with Pro and Founding.
                Try asking your AI app to organize meeting notes, find an idea,
                or add a task to today.
              </p>
            )}
          </AccordionContent>
        </AccordionItem>
        <AccordionItem
          value="access"
          className="overflow-hidden rounded-xl border-0 ring-1 ring-foreground/10"
        >
          <AccordionTrigger
            aria-label="Connection access"
            className="items-center gap-3 rounded-none bg-card px-4 py-3 hover:no-underline focus-visible:ring-inset"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>Access</span>
              <span className="text-sm font-normal text-muted-foreground">
                Review authorized apps and personal API keys.
              </span>
            </span>
            <span
              aria-hidden="true"
              className="text-xs font-normal text-muted-foreground"
            >
              {open.includes("access") ? "Collapse" : "Expand"}
            </span>
          </AccordionTrigger>
          <AccordionContent
            keepMounted
            className="divide-y divide-border border-t bg-card pb-0 [&_p:not(:last-child)]:mb-0"
          >
            <McpConnections />
            <div id="capture-keys" className="scroll-mt-20 p-4">
              <ApiKeysSettings open={keysOpen} onOpenChange={setKeysOpen} />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <McpConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <CliSetupDialog open={cliOpen} onOpenChange={setCliOpen} />
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
          icon={<FileUploadIcon />}
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
          icon={<CopyIcon />}
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

/** Daily notes options (ADR 0070). Week start stays available while Daily notes
 *  is off (ADR 0068); the presentation options are disabled until it is on.
 *  Account-wide and optimistic; a failed save rolls back and says so. */
function DailyNotesOptions() {
  const preferences = useEditorFeatures();
  const [saving, setSaving] = useState(false);
  const disabled = !preferences.ready || !preferences.daily || saving;
  const save = (run: () => Promise<void>, label: string) => {
    setSaving(true);
    void run()
      .catch(() =>
        toast.error(
          `Couldn't save ${label}. Your previous setting was restored.`,
        ),
      )
      .finally(() => setSaving(false));
  };
  const toggle = (option: DailyToggle, label: string) => (enabled: boolean) =>
    save(() => setDailyToggle(option, enabled), label);
  return (
    <>
      <SettingsOptionRow
        title="Week starts on"
        description="Changes your Daily calendar and reorganizes its weeks."
      >
        <span aria-live="polite" className="contents">
          {preferences.weekStartSaving ? (
            <LoaderIcon
              className="size-4 animate-spin text-muted-foreground"
              aria-label="Reorganizing Daily calendar"
            />
          ) : null}
        </span>
        <Segmented
          label="Week starts on"
          value={preferences.weekStart}
          disabled={!preferences.ready || preferences.weekStartSaving}
          onChange={(weekStart) => {
            void setWeekStart(weekStart)
              .then(() =>
                toast.success(
                  `Weeks now start on ${weekStart === "sunday" ? "Sunday" : "Monday"}`,
                ),
              )
              .catch(() =>
                toast.error(
                  "Couldn't change when weeks start. Nothing was moved.",
                ),
              );
          }}
          options={[
            { value: "sunday", label: "Sunday" },
            { value: "monday", label: "Monday" },
          ]}
        />
      </SettingsOptionRow>
      <SettingsOptionRow
        title="Day stream"
        description={
          <span id="day-stream-status">
            Temporarily unavailable because scrolling between days can jump or
            skip. We're working to bring it back. Daily notes still open one day
            at a time.
          </span>
        }
      >
        <SettingsSwitchTarget>
          <Switch
            aria-label="Day stream"
            aria-describedby="day-stream-status"
            checked={preferences.dayStream}
            disabled
          />
        </SettingsSwitchTarget>
      </SettingsOptionRow>
      <SettingsOptionRow
        title="Empty days"
        description="How the day stream shows days with nothing written."
      >
        <Segmented<EmptyDaysMode>
          label="Empty days"
          value={preferences.emptyDays}
          disabled={disabled || !preferences.dayStream}
          onChange={(mode) =>
            save(() => setEmptyDaysMode(mode), "how empty days show")
          }
          options={[
            { value: "show", label: "Show" },
            { value: "fold", label: "Fold" },
            { value: "skip", label: "Skip" },
          ]}
        />
      </SettingsOptionRow>
      <SettingsOptionRow
        title="Week strip"
        description="Show the week's days above a daily note."
      >
        <SettingsSwitchTarget>
          <Switch
            aria-label="Week strip"
            checked={preferences.weekStrip}
            disabled={disabled}
            onCheckedChange={toggle("weekStrip", "the week strip")}
          />
        </SettingsSwitchTarget>
      </SettingsOptionRow>
    </>
  );
}

/** Embeds' one option: account-wide consent to contact providers (ADR 0064,
 *  October 8 amendment). It stays switchable while Embeds is off so a
 *  revocation is always reachable. */
function ExternalEmbedsOption() {
  const preferences = useEditorFeatures();
  const [revokeFailed, setRevokeFailed] = useState(false);
  const saveConsent = (enabled: boolean) => {
    setRevokeFailed(false);
    void setExternalEmbeds(enabled).catch(() => {
      setRevokeFailed(!enabled);
      toast.error(
        enabled
          ? "Couldn't allow external embeds. External content remains off in this tab."
          : "Couldn't save the revocation. External embeds remain off in this tab; retry to update your account.",
      );
    });
  };
  return (
    <>
      <SettingsOptionRow
        title="Allow external embeds"
        description="Automatically load supported providers on all devices signed in to your account. This sends requests to those providers, which may use cookies or tracking."
      >
        <SettingsSwitchTarget>
          <Switch
            aria-label="Allow external embeds"
            checked={preferences.externalEmbeds}
            disabled={!preferences.ready || preferences.externalEmbedsSaving}
            onCheckedChange={saveConsent}
          />
        </SettingsSwitchTarget>
      </SettingsOptionRow>
      {revokeFailed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 py-2 pr-4 pl-8 text-sm text-muted-foreground"
        >
          Account permission could not be revoked. Other devices may still load
          embeds.
          <Button
            variant="ghost"
            size="sm"
            disabled={preferences.externalEmbedsSaving}
            onClick={() => saveConsent(false)}
          >
            Retry revocation
          </Button>
        </div>
      )}
    </>
  );
}

const PLUGINS: {
  id: EditorFeature;
  /** The `/settings#…` anchor that opens this plugin's options. */
  anchor: string;
  name: string;
  description: string;
  off: string;
  Options?: () => ReactNode;
}[] = [
  {
    id: "bible",
    anchor: "bible",
    name: "Bible references",
    description: "Turn Scripture references into interactive passage chips.",
    off: "References stay as plain text.",
  },
  {
    id: "daily",
    anchor: "daily",
    name: "Daily notes",
    description: "A place for each day, with Today and calendar navigation.",
    off: "Your existing notes stay in your outline.",
    Options: DailyNotesOptions,
  },
  {
    id: "embeds",
    anchor: "embeds",
    name: "Embeds",
    description: "Show supported external resources as embed nodes.",
    off: "Embed nodes stay as usable links.",
    Options: ExternalEmbedsOption,
  },
  {
    id: "focusSessions",
    anchor: "focus",
    name: "Focus sessions",
    description: "A timer for one node at a time, with Pomodoro breaks.",
    off: "The timer and its commands stop appearing.",
    Options: FocusSettings,
  },
];

/** The plugin opened by `/settings#<anchor>`, if any. */
function anchoredPlugin(anchor: string): string[] {
  return PLUGINS.some((p) => p.Options && p.anchor === anchor) ? [anchor] : [];
}

/** Every optional plugin as one row: name, description, and an account-wide
 *  switch. A plugin with options opens them in place; only one opens at a
 *  time, and all start closed unless the URL names one. */
function PluginsSection() {
  const preferences = useEditorFeatures();
  const [saving, setSaving] = useState<EditorFeature | null>(null);
  // Follow the router's hash, so a link to `#embeds` opens Embeds even when
  // Settings is already showing.
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState<string[]>(() => anchoredPlugin(hash));
  const [openedHash, setOpenedHash] = useState(hash);
  if (hash !== openedHash) {
    setOpenedHash(hash);
    setOpen(anchoredPlugin(hash));
  }

  const toggle = (feature: EditorFeature, name: string, enabled: boolean) => {
    setSaving(feature);
    void Effect.runPromise(
      Effect.tryPromise(() => setEditorFeature(feature, enabled)).pipe(
        Effect.catch(() =>
          Effect.sync(() =>
            toast.error(
              `Couldn't save ${name.toLowerCase()}. Your previous setting was restored.`,
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(null))),
      ),
    );
  };

  return (
    <Section
      title="Plugins"
      description="Turning one off never deletes your notes. These settings follow your account across devices."
    >
      <Accordion
        value={open}
        onValueChange={(value) => setOpen(value.map(String))}
        className="overflow-hidden rounded-xl ring-1 ring-foreground/10"
      >
        {PLUGINS.map(({ id, anchor, name, description, off, Options }) => {
          const enabled = preferences[id];
          const summary = (
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-foreground">
                {name}
              </span>
              <span className="mt-0.5 text-sm font-normal text-muted-foreground">
                {description}
                {!enabled && (
                  <span className="mt-1 block text-xs">Off. {off}</span>
                )}
              </span>
            </span>
          );
          const header = (
            <div className="flex items-center gap-1 bg-card pr-4 [&>h3]:min-w-0 [&>h3]:flex-1">
              {Options ? (
                <AccordionTrigger
                  aria-label={`${name} options`}
                  className="items-center gap-3 rounded-none border-0 py-3 pl-4 hover:no-underline focus-visible:ring-inset"
                >
                  {summary}
                </AccordionTrigger>
              ) : (
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3 py-3 pl-4">
                  {summary}
                  {/* Keeps switches aligned with rows that have a chevron. */}
                  <span aria-hidden="true" className="size-4 shrink-0" />
                </div>
              )}
              <SettingsSwitchTarget>
                <Switch
                  aria-label={name}
                  checked={enabled}
                  disabled={!preferences.ready || saving !== null}
                  onCheckedChange={(next) => toggle(id, name, next)}
                />
              </SettingsSwitchTarget>
            </div>
          );
          return (
            <AccordionItem
              key={id}
              value={anchor}
              id={anchor}
              className="scroll-mt-20"
            >
              {header}
              {Options && (
                <AccordionContent className="pb-0">
                  <div className="divide-y divide-border border-t bg-muted/30">
                    <Options />
                  </div>
                </AccordionContent>
              )}
            </AccordionItem>
          );
        })}
      </Accordion>
      {!preferences.ready && (
        <p role="status" className="text-sm text-muted-foreground">
          {preferences.error ? (
            <>
              Couldn't load your plugin settings.{" "}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void Effect.runPromise(
                    Effect.tryPromise(() => retryEditorFeatures()).pipe(
                      Effect.catch(() =>
                        Effect.sync(() =>
                          toast.error("Couldn't load your plugin settings."),
                        ),
                      ),
                    ),
                  );
                }}
              >
                Retry
              </Button>
            </>
          ) : (
            "Loading your plugin settings…"
          )}
        </p>
      )}
    </Section>
  );
}

/** A theme's swatch: a preset's page and primary, or a custom theme's first
 *  and second colors (ADR 0088). */
function ThemeSwatch({ id }: { id: ColorThemeId }) {
  const seed = parseCustomTheme(id);
  let background: string;
  if (seed) {
    const dark = document.documentElement.classList.contains("dark");
    const first = seedColor(seed.h, seed.c, dark);
    const second = seed.second
      ? seedColor(seed.second.h, seed.second.c, dark)
      : first;
    background = `linear-gradient(135deg, ${second} 50%, ${first} 50%)`;
  } else {
    const swatch = COLOR_THEMES.find((t) => t.id === id)?.swatch;
    background = swatch
      ? `linear-gradient(135deg, ${swatch[0]} 50%, ${swatch[1]} 50%)`
      : "transparent";
  }
  return (
    <span
      aria-hidden="true"
      className="size-3 shrink-0 rounded-full ring-1 ring-foreground/15"
      style={{ background }}
    />
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const colorTheme = useColorTheme();
  const preview = useColorThemePreview();
  const membership = useMembership();
  const customTheme = isCustomTheme(colorTheme)
    ? colorTheme
    : customThemeToReopen();
  const locked = (id: ColorThemeId) =>
    membership.plan === "free" &&
    id !== "default" &&
    !(membership.legacyLeaf && id === "leaf");
  const { textSize, setTextSize } = useTextSize();
  const preferences = useEditorFeatures();
  const [saving, setSaving] = useState<
    Partial<Record<AppearanceToggle, boolean>>
  >({});
  const toggle = (name: AppearanceToggle, label: string, enabled: boolean) => {
    setSaving((s) => ({ ...s, [name]: true }));
    void Effect.runPromise(
      Effect.tryPromise(() => setAppearanceToggle(name, enabled)).pipe(
        Effect.catch(() =>
          Effect.sync(() =>
            toast.error(
              `Couldn't save ${label}. Your previous setting was restored.`,
            ),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => setSaving((s) => ({ ...s, [name]: false }))),
        ),
      ),
    );
  };
  return (
    <div id="appearance" className="scroll-mt-20">
      <Section title="Appearance">
        <RowGroup>
          {/* The color theme (ADR 0082): one row like Mode, with the choices
            in a menu (a sheet on narrow screens). */}
          <div className="flex flex-col gap-3 bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">Theme</div>
                <div className="mt-0.5 text-sm text-muted-foreground">
                  {membership.state === "ready" && membership.plan !== "free"
                    ? "Included with your subscription"
                    : "Included with Pro"}
                </div>
              </div>
              <ResponsiveMenu title="Theme">
                <ResponsiveMenuTrigger
                  aria-label={`Theme, ${colorThemeLabel(colorTheme)}`}
                  disabled={membership.state !== "ready"}
                  className="inline-flex h-8 max-w-48 shrink-0 items-center gap-2 rounded-lg bg-muted pr-2 pl-3 text-[0.8rem] font-medium text-foreground transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
                >
                  <ThemeSwatch id={colorTheme} />
                  <span className="truncate">
                    {colorThemeLabel(colorTheme)}
                  </span>
                  <ChevronDownIcon />
                </ResponsiveMenuTrigger>
                <ResponsiveMenuContent align="end" className="w-56">
                  <ResponsiveMenuRadioGroup
                    value={colorTheme}
                    // SAFETY: every item's value is a preset id or customTheme.
                    onValueChange={(id) => setColorTheme(id as ColorThemeId)}
                  >
                    {COLOR_THEMES.map((t) => (
                      <ResponsiveMenuRadioItem
                        key={t.id}
                        value={t.id}
                        aria-label={
                          locked(t.id)
                            ? `${t.label}, preview with Pro or Founding`
                            : t.label
                        }
                      >
                        <ThemeSwatch id={t.id} />
                        {t.label}
                      </ResponsiveMenuRadioItem>
                    ))}
                    <ResponsiveMenuSeparator />
                    {/* One custom slot that reopens this device's last custom
                      theme (ADR 0088). */}
                    <ResponsiveMenuRadioItem
                      value={customTheme}
                      aria-label={`Custom, ${colorThemeLabel(customTheme)}${
                        locked(customTheme)
                          ? ", preview with Pro or Founding"
                          : ""
                      }`}
                    >
                      <ThemeSwatch id={customTheme} />
                      Custom
                      <span className="truncate text-muted-foreground">
                        {colorThemeLabel(customTheme)}
                      </span>
                    </ResponsiveMenuRadioItem>
                  </ResponsiveMenuRadioGroup>
                </ResponsiveMenuContent>
              </ResponsiveMenu>
            </div>
            {isCustomTheme(colorTheme) && (
              <CustomThemePicker
                value={colorTheme}
                disabled={membership.state !== "ready"}
              />
            )}
            {preview ? (
              <div
                className="flex flex-col gap-3 rounded-lg bg-muted p-3"
                role="status"
              >
                <p className="text-sm font-medium">
                  Previewing {colorThemeLabel(preview)}
                </p>
                <p className="text-sm text-muted-foreground">
                  Try it here. Unlock themes to keep your choice on every
                  device.
                </p>
                <ul className="list-inside list-disc rounded-lg bg-background p-3 text-sm">
                  <li>Room for your next idea</li>
                  <li>A little more space to think</li>
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => openMembership("themes")}>
                    Unlock themes
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={endColorThemePreview}
                  >
                    End preview
                  </Button>
                </div>
              </div>
            ) : membership.plan === "free" ? (
              <p className="text-sm text-muted-foreground">
                Dotflowy is free. Try any other palette before you subscribe.
              </p>
            ) : null}
            {membership.state === "error" && (
              <p role="alert" className="text-sm text-muted-foreground">
                Couldn't load your plan.{" "}
                <button className="underline" onClick={membership.reload}>
                  Try again
                </button>
              </p>
            )}
          </div>
          <SettingRow
            title="Mode"
            action={
              <Segmented
                label="Mode"
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
            title="Show AI app icons"
            description={
              <span id="ai-app-icons-description">
                Show which AI app created each node. Turn off to use a generic
                sparkle instead.
              </span>
            }
            action={
              <SettingsSwitchTarget>
                <Switch
                  aria-label="Show AI app icons"
                  aria-describedby="ai-app-icons-description"
                  checked={preferences.aiAppIcons}
                  disabled={!preferences.ready || saving.aiAppIcons}
                  onCheckedChange={(on) =>
                    toggle("aiAppIcons", "AI app icons", on)
                  }
                />
              </SettingsSwitchTarget>
            }
          />
          <SettingRow
            title="Show indent guides"
            description={
              <span id="indent-guides-description">
                Draw a faint line beside nested items, so you can trace each one
                back to its parent.
              </span>
            }
            action={
              <SettingsSwitchTarget>
                <Switch
                  aria-label="Show indent guides"
                  aria-describedby="indent-guides-description"
                  checked={preferences.indentGuides}
                  disabled={!preferences.ready || saving.indentGuides}
                  onCheckedChange={(on) =>
                    toggle("indentGuides", "indent guides", on)
                  }
                />
              </SettingsSwitchTarget>
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
    </div>
  );
}

function SettingsPage() {
  const subscriptions = useMembership();
  const plan = subscriptions.plan;

  return (
    <main className="min-h-dvh bg-background">
      {/* Minimal page header: back to the outline + title. The outline's own
          header (Header.tsx) doesn't render on this route, so /settings carries
          its own chrome. */}
      <header className="sticky top-[env(titlebar-area-height,0px)] z-10 border-b bg-background/80 backdrop-blur">
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
        <div id="billing" className="scroll-mt-20">
          <Section
            title="Plan & billing"
            description="Your plan, usage, and payment."
          >
            <PlanBilling {...subscriptions} />
          </Section>
        </div>
        <ConnectionsSection plan={plan} />
        <PluginsSection />
        <AppearanceSection />
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Other settings
          </summary>
          <div className="mt-6 flex flex-col gap-10">
            <AccountSection />
            <DataSection />
          </div>
        </details>
      </div>
    </main>
  );
}
