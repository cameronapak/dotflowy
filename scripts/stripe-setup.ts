/**
 * Idempotent Stripe object setup — replaces steps 1–2 of the manual dashboard
 * checklist on issue #172 (products, prices, and the live webhook endpoint).
 *
 * The lookup KEYS are the state. There is no local state file: on every run we
 * ask Stripe which Prices already carry our lookup keys (`prices.list({
 * lookup_keys })`) and only create what's missing. Re-running is a no-op.
 *
 * Prices are immutable in Stripe — you cannot edit an amount or interval. So if
 * a Price already exists under a lookup key but its amount/interval disagrees
 * with the spec below, this script WARNS loudly and does nothing: changing a
 * price is a deliberate new-Price + `transfer_lookup_key` migration, out of
 * scope for a setup script.
 *
 * Products are found-or-created, tagged `metadata.dotflowy_managed="true"` and
 * matched by that tag + name, so a re-run reuses the same Product.
 *
 * The webhook endpoint is LIVE-mode only (test mode uses `stripe listen`).
 *
 *   Usage:
 *     STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts            # test mode
 *     STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts --dry-run  # plan only
 *     STRIPE_SECRET_KEY=sk_live_… bun scripts/stripe-setup.ts --live     # prod (guarded)
 *
 * The key is read from the STRIPE_SECRET_KEY env var per invocation and is
 * never written anywhere. A live key REQUIRES the explicit `--live` flag or the
 * script refuses. `--dry-run` prints the plan (EXISTS / would CREATE / MISMATCH)
 * without writing a thing.
 */
import Stripe from "stripe";

// Canonical source of these strings is worker/auth.ts (STRIPE_LOOKUP_KEYS).
// Mirrored (not imported) on purpose: importing worker/auth.ts drags the whole
// better-auth + @cloudflare/workers-types graph into this plain Bun script just
// for three constants. Keep in sync with worker/auth.ts — it wins on any drift.
const LOOKUP_KEYS = {
  unlimitedMonthly: "dotflowy_unlimited_monthly",
  unlimitedAnnual: "dotflowy_unlimited_annual",
  founding: "dotflowy_founding",
} as const;

const WEBHOOK_URL = "https://app.dotflowy.com/api/auth/stripe/webhook";
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

const MANAGED_TAG = { key: "dotflowy_managed", value: "true" } as const;

/** A Price we want to exist. Amounts in the smallest currency unit (cents). */
interface PriceSpec {
  lookupKey: string;
  /** Human label for the summary line. */
  label: string;
  /** The Product this Price belongs to (found-or-created by name + tag). */
  productName: string;
  unitAmount: number;
  currency: "usd";
  interval: "month" | "year";
  intervalCount: number;
}

// Amounts + intervals cross-checked against worker/auth.ts (the STRIPE_LOOKUP_KEYS
// comment: unlimited $5/mo · $48/yr; founding $99 · 3-year interval).
const PRICE_SPECS: PriceSpec[] = [
  {
    lookupKey: LOOKUP_KEYS.unlimitedMonthly,
    label: "Unlimited monthly ($5/mo)",
    productName: "Dotflowy Unlimited",
    unitAmount: 500,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
  },
  {
    lookupKey: LOOKUP_KEYS.unlimitedAnnual,
    label: "Unlimited annual ($48/yr)",
    productName: "Dotflowy Unlimited",
    unitAmount: 4800,
    currency: "usd",
    interval: "year",
    intervalCount: 1,
  },
  {
    lookupKey: LOOKUP_KEYS.founding,
    label: "Founding ($99 / 3yr)",
    productName: "Dotflowy Founding",
    unitAmount: 9900,
    currency: "usd",
    interval: "year",
    intervalCount: 3,
  },
];

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};
const log = (msg = "") => console.log(msg);
const fail = (msg: string): never => {
  console.error(`${C.red}✗ ${msg}${C.reset}`);
  process.exit(1);
};

function detectMode(key: string): "test" | "live" {
  const m = /^(sk|rk)_(test|live)_/.exec(key);
  if (!m) {
    fail(
      "STRIPE_SECRET_KEY is not a recognizable Stripe secret/restricted key " +
        "(expected an sk_test_… / sk_live_… / rk_test_… / rk_live_… prefix).",
    );
  }
  return m![2] as "test" | "live";
}

function fmtAmount(
  spec: Pick<
    PriceSpec,
    "unitAmount" | "currency" | "interval" | "intervalCount"
  >,
) {
  const dollars = (spec.unitAmount / 100).toFixed(2);
  const every =
    spec.intervalCount === 1
      ? spec.interval
      : `${spec.intervalCount} ${spec.interval}s`;
  return `$${dollars} ${spec.currency.toUpperCase()} / ${every}`;
}

/** Compare a live Price to the spec. Returns null if it matches, else the diff. */
function priceMismatch(price: Stripe.Price, spec: PriceSpec): string | null {
  const problems: string[] = [];
  if (price.unit_amount !== spec.unitAmount)
    problems.push(`amount ${price.unit_amount} ≠ ${spec.unitAmount}`);
  if (price.currency !== spec.currency)
    problems.push(`currency ${price.currency} ≠ ${spec.currency}`);
  if (price.recurring?.interval !== spec.interval)
    problems.push(`interval ${price.recurring?.interval} ≠ ${spec.interval}`);
  if ((price.recurring?.interval_count ?? 1) !== spec.intervalCount)
    problems.push(
      `interval_count ${price.recurring?.interval_count} ≠ ${spec.intervalCount}`,
    );
  return problems.length ? problems.join(", ") : null;
}

async function findOrCreateProduct(
  stripe: Stripe,
  name: string,
  dryRun: boolean,
  cache: Map<string, string>,
): Promise<string | null> {
  const cached = cache.get(name);
  if (cached) return cached;

  // No server-side filter for metadata on products.list, so page through the
  // managed products and match by name + our tag. There are only a handful.
  for await (const product of stripe.products.list({
    active: true,
    limit: 100,
  })) {
    if (
      product.name === name &&
      product.metadata?.[MANAGED_TAG.key] === MANAGED_TAG.value
    ) {
      cache.set(name, product.id);
      log(
        `  ${C.green}EXISTS${C.reset}  product "${name}" ${C.dim}(${product.id})${C.reset}`,
      );
      return product.id;
    }
  }

  if (dryRun) {
    log(
      `  ${C.cyan}CREATE${C.reset}  product "${name}" ${C.dim}(dry-run, not created)${C.reset}`,
    );
    return null;
  }
  const created = await stripe.products.create({
    name,
    metadata: { [MANAGED_TAG.key]: MANAGED_TAG.value },
  });
  cache.set(name, created.id);
  log(
    `  ${C.cyan}CREATED${C.reset} product "${name}" ${C.dim}(${created.id})${C.reset}`,
  );
  return created.id;
}

async function ensurePrices(stripe: Stripe, dryRun: boolean) {
  log(`${C.bold}Products + Prices${C.reset}`);

  // One list call resolves every lookup key we care about.
  const existing = await stripe.prices.list({
    lookup_keys: PRICE_SPECS.map((s) => s.lookupKey),
    expand: ["data.product"],
    limit: 100,
  });
  const byKey = new Map<string, Stripe.Price>();
  for (const price of existing.data) {
    if (price.lookup_key) byKey.set(price.lookup_key, price);
  }

  const productCache = new Map<string, string>();
  let created = 0;
  let mismatches = 0;

  for (const spec of PRICE_SPECS) {
    const found = byKey.get(spec.lookupKey);
    if (found) {
      const diff = priceMismatch(found, spec);
      if (diff) {
        mismatches++;
        log(
          `  ${C.yellow}MISMATCH${C.reset} ${spec.label} ${C.dim}[${spec.lookupKey}]${C.reset}`,
        );
        log(`           ${C.yellow}${found.id} disagrees: ${diff}${C.reset}`);
        log(
          `           ${C.dim}Prices are immutable — left untouched. To change price, create a new Price and transfer_lookup_key.${C.reset}`,
        );
      } else {
        log(
          `  ${C.green}EXISTS${C.reset}  price   ${spec.label} ${C.dim}[${spec.lookupKey}] ${found.id}${C.reset}`,
        );
      }
      continue;
    }

    // Missing — ensure its product, then create (unless dry-run).
    const productId = await findOrCreateProduct(
      stripe,
      spec.productName,
      dryRun,
      productCache,
    );
    if (dryRun) {
      log(
        `  ${C.cyan}CREATE${C.reset}  price   ${spec.label} ${C.dim}[${spec.lookupKey}] ${fmtAmount(spec)}${C.reset}`,
      );
      created++;
      continue;
    }
    const price = await stripe.prices.create({
      product: productId!,
      lookup_key: spec.lookupKey,
      unit_amount: spec.unitAmount,
      currency: spec.currency,
      recurring: {
        interval: spec.interval,
        interval_count: spec.intervalCount,
      },
    });
    created++;
    log(
      `  ${C.cyan}CREATED${C.reset} price   ${spec.label} ${C.dim}[${spec.lookupKey}] ${price.id} ${fmtAmount(spec)}${C.reset}`,
    );
  }

  return { created, mismatches };
}

async function ensureWebhook(
  stripe: Stripe,
  mode: "test" | "live",
  dryRun: boolean,
) {
  log();
  log(`${C.bold}Webhook endpoint${C.reset}`);
  if (mode !== "live") {
    log(
      `  ${C.dim}SKIP    test mode — local dev uses \`stripe listen\`, not a registered endpoint.${C.reset}`,
    );
    return;
  }

  let existing: Stripe.WebhookEndpoint | undefined;
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (endpoint.url === WEBHOOK_URL) {
      existing = endpoint;
      break;
    }
  }

  const wanted = [...WEBHOOK_EVENTS].sort();
  if (existing) {
    const have = [...(existing.enabled_events ?? [])].sort();
    const matches =
      have.length === wanted.length && have.every((e, i) => e === wanted[i]);
    log(
      `  ${C.green}EXISTS${C.reset}  ${WEBHOOK_URL} ${C.dim}(${existing.id})${C.reset}`,
    );
    if (matches) {
      log(`  ${C.dim}events match the spec.${C.reset}`);
    } else {
      log(
        `  ${C.yellow}events differ — have [${have.join(", ")}], want [${wanted.join(", ")}].${C.reset}`,
      );
      log(
        `  ${C.dim}Reconcile in the dashboard (left untouched — this script doesn't edit endpoints).${C.reset}`,
      );
    }
    log(
      `  ${C.dim}Stripe never re-reveals the signing secret. If STRIPE_WEBHOOK_SECRET is lost, roll it in the dashboard.${C.reset}`,
    );
    return;
  }

  if (dryRun) {
    log(
      `  ${C.cyan}CREATE${C.reset}  ${WEBHOOK_URL} ${C.dim}(dry-run, not created)${C.reset}`,
    );
    log(`  ${C.dim}events: ${wanted.join(", ")}${C.reset}`);
    return;
  }

  const created = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: [
      ...WEBHOOK_EVENTS,
    ] as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
  });
  log(
    `  ${C.cyan}CREATED${C.reset} ${WEBHOOK_URL} ${C.dim}(${created.id})${C.reset}`,
  );
  log();
  log(
    `  ${C.bold}${C.yellow}⚠ Signing secret — shown ONCE, save it now:${C.reset}`,
  );
  log(`  ${C.bold}${created.secret}${C.reset}`);
  log();
  log(`  Store it as a Worker secret:`);
  log(`    ${C.cyan}wrangler secret put STRIPE_WEBHOOK_SECRET${C.reset}`);
  log(`  ${C.dim}Stripe will never show this value again.${C.reset}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const liveFlag = args.has("--live");

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    fail(
      "Missing STRIPE_SECRET_KEY. Set it per invocation, e.g.\n" +
        "  STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts",
    );
  }

  const mode = detectMode(key!);
  if (mode === "live" && !liveFlag) {
    fail(
      "Refusing to touch LIVE Stripe without the explicit --live flag. " +
        "Re-run with --live once you're sure.",
    );
  }

  const stripe = new Stripe(key!);

  log();
  log(
    `${C.bold}Stripe setup${C.reset} — mode ${C.bold}${mode.toUpperCase()}${C.reset}` +
      (dryRun ? ` ${C.yellow}(dry-run: no writes)${C.reset}` : ""),
  );
  log(`${C.dim}${"─".repeat(56)}${C.reset}`);

  const { created, mismatches } = await ensurePrices(stripe, dryRun);
  await ensureWebhook(stripe, mode, dryRun);

  log();
  log(`${C.dim}${"─".repeat(56)}${C.reset}`);
  if (mismatches > 0) {
    log(
      `${C.yellow}${mismatches} price mismatch(es) — see above. Nothing was changed for them.${C.reset}`,
    );
  }
  log(
    dryRun
      ? `${C.bold}Dry run complete.${C.reset} ${created} object(s) would be created.`
      : `${C.bold}Done.${C.reset} ${created} object(s) created this run.`,
  );
  // A mismatch is a warning, not a hard failure — the operator decides.
}

main().catch((err) => {
  console.error(
    `${C.red}✗ Stripe setup failed:${C.reset}`,
    err?.message ?? err,
  );
  process.exit(1);
});
