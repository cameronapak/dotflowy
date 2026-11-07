import {
  createContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

export type MobileBreadcrumbProps = {
  /** Every ancestor except Home, ending at the direct parent. */
  ancestors: { id: string; label: string }[];
  onNavigate: (id: string | null) => void;
  /** Wraps the existing breadcrumb menu around the toolbar's trigger. */
  renderMenu: (trigger: ReactElement<ComponentProps<"button">>) => ReactNode;
};

/**
 * The narrow-screen glass toolbar provides its breadcrumb component here, so
 * the editor's trail can render it without importing the glass package or
 * adding a second lazy Suspense boundary (ADR 0076).
 */
export const MobileBreadcrumb = createContext<
  ((props: MobileBreadcrumbProps) => ReactNode) | null
>(null);
