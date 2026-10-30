import type { ReactNode } from "react";

/** One option inside an expanded plugin on /settings: label and caption on the
 *  left, the control on the right. Shared by core and plugin settings so every
 *  plugin's options line up on the same edges. */
export function SettingsOptionRow({
  title,
  description,
  htmlFor,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Id of the control when it is a native input, so the title labels it. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 pr-4 pl-8">
      <div className="min-w-0 py-1">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-sm font-medium text-foreground"
          >
            {title}
          </label>
        ) : (
          <div className="text-sm font-medium text-foreground">{title}</div>
        )}
        {description && (
          <div className="mt-0.5 text-sm text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** A switch's 44px touch target (ADR 0029) inside a settings row. */
export function SettingsSwitchTarget({ children }: { children: ReactNode }) {
  return (
    <div className="-my-1 flex size-11 items-center justify-center">
      {children}
    </div>
  );
}
