import { Tick02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

import { startCheckout } from "../data/membership";
import { COLOR_THEMES, useColorThemePreview } from "./color-theme";
import {
  setMembershipOpener,
  type MembershipReason,
} from "./membership-opener";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

export function MembershipDialog() {
  const [reason, setReason] = useState<MembershipReason | null>(null);
  const [choice, setChoice] = useState("yearly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useColorThemePreview();
  useEffect(() => {
    setMembershipOpener((value) => {
      setReason(value);
      setError(null);
    });
    return () => setMembershipOpener(null);
  }, []);
  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      await startCheckout(
        choice === "founding" ? "founding" : "unlimited",
        choice === "yearly",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't start checkout. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={reason !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setReason(null);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {reason === "themes"
              ? `Make ${COLOR_THEMES.find((t) => t.id === preview)?.label ?? "Dotflowy"} yours`
              : reason === "connections"
                ? "Connect your AI apps to Dotflowy"
                : "Become a Dotflowy member"}
          </DialogTitle>
          <DialogDescription>
            More room for your thoughts, and support for what comes next.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {[
            "Every theme, on every device",
            "Connect Claude, Cursor, VS Code, ChatGPT, and the CLI",
            "No 10,000-node limit",
            "Send ideas and feedback straight to Cam",
          ].map((benefit) => (
            <li key={benefit} className="flex items-start gap-2">
              <HugeiconsIcon
                icon={Tick02Icon}
                className="mt-0.5 size-4 shrink-0 text-primary-ink"
              />
              {benefit}
            </li>
          ))}
        </ul>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="membership-plan">Choose your plan</FieldLabel>
            <NativeSelect
              id="membership-plan"
              value={choice}
              disabled={busy}
              onChange={(event) => setChoice(event.target.value)}
            >
              <NativeSelectOption value="monthly">
                Pro · $5 / month
              </NativeSelectOption>
              <NativeSelectOption value="yearly">
                Pro · $48 / year
              </NativeSelectOption>
              <NativeSelectOption value="founding">
                Founding · $99 / 3 years
              </NativeSelectOption>
            </NativeSelect>
          </Field>
        </FieldGroup>
        <p className="text-sm text-muted-foreground">
          {choice === "founding"
            ? "Limited to 50 seats. Renews after 3 years unless you cancel."
            : choice === "yearly"
              ? "$48 billed yearly. Renews each year unless you cancel."
              : "$5 billed monthly. Renews each month unless you cancel."}{" "}
          Cancel anytime in Settings.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setReason(null)}
          >
            Not now
          </Button>
          <Button disabled={busy} onClick={() => void checkout()}>
            {busy && (
              <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
            )}
            Continue to checkout
          </Button>
        </DialogFooter>
        <p className="text-xs text-muted-foreground">
          Checkout opens Stripe. Bug reporting stays free on every plan.
        </p>
      </DialogContent>
    </Dialog>
  );
}
