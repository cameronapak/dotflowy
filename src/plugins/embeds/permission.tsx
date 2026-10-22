import { useState } from "react";

import type { PluginContext } from "../types";

import {
  setExternalEmbeds,
  useEditorFeatures,
} from "../../data/editor-features";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogClose,
} from "../kit";

function PermissionDialog({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  returnFocus?: HTMLElement;
}) {
  const prefs = useEditorFeatures();
  const [error, setError] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !prefs.externalEmbedsSaving) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!prefs.externalEmbedsSaving}
        finalFocus={() => returnFocus ?? true}
      >
        <DialogHeader>
          <DialogTitle>Allow external embeds?</DialogTitle>
          <DialogDescription>
            Embeds will load automatically across your account, on all your
            devices. Providers receive requests and may use cookies or tracking.
            You can turn this off in Settings.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            Couldn't save permission. Embeds remain off here. Try again.
          </p>
        )}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="ghost" disabled={prefs.externalEmbedsSaving} />
            }
          >
            Not now
          </DialogClose>
          <Button
            disabled={prefs.externalEmbedsSaving}
            onClick={() => {
              setError(false);
              void setExternalEmbeds(true).then(onClose, () => setError(true));
            }}
          >
            {prefs.externalEmbedsSaving ? "Saving permission…" : "Allow embeds"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function requestPermission(
  ctx: PluginContext,
  returnFocus?: HTMLElement,
) {
  ctx.openOverlay(
    <PermissionDialog
      returnFocus={returnFocus}
      onClose={() => ctx.openOverlay(null)}
    />,
  );
}
