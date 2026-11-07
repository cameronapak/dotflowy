import { Home01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { TabBar } from "@onlymoein/liquidglass";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";

import type { HeaderSlotSpec, PluginContext } from "../plugins/types";

import { useOpaqueChrome } from "../hooks/use-opaque-chrome";

const NavigationContext = createContext<{
  slots: HeaderSlotSpec[];
  getCtx: () => PluginContext;
} | null>(null);

/** The package uses href; TanStack owns SPA navigation and modified clicks. */
function NavigationLink({ href, ...props }: ComponentProps<"a">) {
  const context = useContext(NavigationContext);
  const navigate = useNavigate();
  return (
    <Link
      {...props}
      to={href ?? "/"}
      activeProps={{}}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const tab = context?.slots.find(
          (slot) => slot.mobileTab?.href === href,
        )?.mobileTab;
        if (context && tab?.onSelect) {
          event.preventDefault();
          tab.onSelect(context.getCtx, navigate);
        }
      }}
    />
  );
}

/** Narrow-screen destinations, separate from header actions (ADR 0076). */
export default function MobileNavigation({
  slots,
  getCtx,
}: {
  slots: HeaderSlotSpec[];
  getCtx: () => PluginContext;
}) {
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const { day } = useSearch({ strict: false });
  const opaque = useOpaqueChrome();
  const [keyboard, setKeyboard] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () =>
      setKeyboard(
        !!viewport &&
          window.innerHeight - viewport.height * viewport.scale > 100,
      );
    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const destinations = slots.flatMap((slot) =>
    slot.mobileTab
      ? [
          {
            value: slot.id,
            label: slot.mobileTab.label,
            href: slot.mobileTab.href,
            icon: slot.mobileTab.icon,
          },
        ]
      : [],
  );
  const items = [
    {
      value: "home",
      label: "Home",
      href: "/",
      icon: <HugeiconsIcon icon={Home01Icon} aria-hidden="true" />,
    },
    ...destinations,
  ];
  const selected =
    rootId === null
      ? "home"
      : (slots.find((slot) => slot.mobileTab?.isActive(rootId, day))?.id ??
        null);

  return createPortal(
    <NavigationContext value={{ slots, getCtx }}>
      <div className="mobile-navigation" hidden={keyboard}>
        {opaque ? (
          <nav
            className="mobile-navigation-solid"
            aria-label="Outline navigation"
          >
            {items.map((item) => (
              <NavigationLink
                key={item.value}
                href={item.href}
                aria-current={selected === item.value ? "page" : undefined}
              >
                {item.icon}
                <span>{item.label}</span>
              </NavigationLink>
            ))}
          </nav>
        ) : (
          <TabBar
            aria-label="Outline navigation"
            items={items}
            value={selected}
            link={NavigationLink}
          />
        )}
      </div>
    </NavigationContext>,
    document.body,
  );
}
