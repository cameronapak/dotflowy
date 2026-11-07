import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  Home01Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Button as GlassButton,
  Toolbar,
  ToolbarGroup,
} from "@onlymoein/liquidglass";
import {
  createContext,
  Fragment,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

import type { HeaderSlotSpec, PluginContext } from "../plugins/types";

import { useUnseenReleaseCount } from "../data/changelog-cursor";
import { useOpaqueChrome } from "../hooks/use-opaque-chrome";
import { HeaderMoreMenu } from "./header-more-menu";
import { openNodeSwitcher } from "./node-switcher-opener";
import { openQuickAdd } from "./quick-add-opener";
import { SpotlightIndicator } from "./spotlight-indicator";

/** Opaque fallback unmounts package glass, like the dock (ADR 0076). */
const Opaque = createContext(false);

function Group({ label, children }: { label: string; children: ReactNode }) {
  return useContext(Opaque) ? (
    <div role="group" aria-label={label} className="glass-header-solid-group">
      {children}
    </div>
  ) : (
    <ToolbarGroup aria-label={label}>{children}</ToolbarGroup>
  );
}

function Btn({
  icon,
  variant,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { icon?: ReactNode; variant?: "filled" }) {
  if (useContext(Opaque))
    return (
      <button
        type="button"
        {...props}
        className={`glass-header-solid-button ${className ?? ""}`}
        data-variant={variant}
      >
        {icon}
        {children}
      </button>
    );
  return (
    <GlassButton {...props} icon={icon} variant={variant} className={className}>
      {children}
    </GlassButton>
  );
}

const icon = (glyph: typeof Search01Icon) => (
  <HugeiconsIcon icon={glyph} aria-hidden="true" />
);

/**
 * Narrow-screen header (ADR 0076): the zoomed page's way back on the leading
 * edge, then Search and More sharing one piece of glass, then Quick add as the
 * one prominent action. Built from the package's Toolbar, ToolbarGroup and
 * Button; the breadcrumb arrives as `leading`.
 */
export default function MobileGlassHeader({
  leading,
  slots,
  getCtx,
}: {
  leading: ReactNode;
  slots: HeaderSlotSpec[];
  getCtx?: () => PluginContext;
}) {
  const opaque = useOpaqueChrome();
  const unseen = useUnseenReleaseCount();

  return (
    <Opaque value={opaque}>
      <Toolbar
        edge={opaque ? "none" : "uniform"}
        aria-label="Outline toolbar"
        className="outline-header mobile-glass-header"
        data-opaque={opaque ? "" : undefined}
      >
        <div className="mobile-glass-header-leading">{leading}</div>
        <div className="mobile-glass-header-trailing">
          <SpotlightIndicator />
          <Group label="Actions">
            {getCtx &&
              slots
                .filter((slot) => !slot.mobileTab)
                .map((slot) => (
                  <Fragment key={slot.id}>{slot.render(getCtx)}</Fragment>
                ))}
            <Btn
              icon={icon(Search01Icon)}
              aria-label="Search"
              onClick={() => openNodeSwitcher()}
            />
            <HeaderMoreMenu
              trigger={
                <Btn
                  icon={
                    <span className="glass-header-badge-host">
                      {icon(MoreHorizontalIcon)}
                      {unseen > 0 && (
                        <span data-changelog-dot="" aria-hidden="true" />
                      )}
                    </span>
                  }
                  aria-label={
                    unseen > 0 ? "More (new releases available)" : "More"
                  }
                />
              }
            />
          </Group>
          <Btn
            variant="filled"
            icon={icon(PlusSignIcon)}
            aria-label="Quick add"
            onClick={openQuickAdd}
          />
        </div>
      </Toolbar>
    </Opaque>
  );
}

/**
 * The zoomed-view breadcrumb on narrow screens: Back to the direct parent (or
 * Home at the top level), plus a chevron that opens every ancestor, Home
 * included. `ancestors` excludes Home and ends at the direct parent;
 * `renderMenu` wraps the existing breadcrumb menu around a trigger.
 */
export function GlassBreadcrumb({
  ancestors,
  onNavigate,
  renderMenu,
}: {
  ancestors: { id: string; label: string }[];
  onNavigate: (id: string | null) => void;
  renderMenu: (trigger: ReactElement<ComponentProps<"button">>) => ReactNode;
}) {
  const parent = ancestors.at(-1);
  return (
    <nav aria-label="Breadcrumb" className="glass-breadcrumb">
      <Group label="Breadcrumb">
        <Btn
          icon={icon(ArrowLeft01Icon)}
          className="glass-crumb"
          aria-label={`Back to ${parent?.label ?? "Home"}`}
          onClick={() => onNavigate(parent?.id ?? null)}
        >
          {parent ? (
            <span className="glass-crumb-label">{parent.label}</span>
          ) : (
            icon(Home01Icon)
          )}
        </Btn>
        {parent &&
          renderMenu(
            <Btn icon={icon(ArrowDown01Icon)} aria-label="Show breadcrumbs" />,
          )}
      </Group>
    </nav>
  );
}
