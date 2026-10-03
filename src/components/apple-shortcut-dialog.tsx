import { useEffect, useState } from "react";

import { setAppleShortcutOpener } from "./apple-shortcut-opener";
import { AppleShortcutSetupDialog } from "./capture-keys-dialog";

/** Mounted once inside AuthGate, like ChangelogDialog. */
export function AppleShortcutDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setAppleShortcutOpener(() => setOpen(true));
    return () => setAppleShortcutOpener(null);
  }, []);

  return <AppleShortcutSetupDialog open={open} onOpenChange={setOpen} />;
}
