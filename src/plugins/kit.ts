// THIS file is the one sanctioned bridge to components/ui; every other plugin
// file must come through here (enforced by the no-restricted-imports override in
// .oxlintrc.json, which excludes this file via `excludeFiles`).
//
// The curated shadcn UI surface a Lane-A plugin may use (ADR 0031). Plugins get
// ANY of these theme-wired primitives -- so a plugin's UI is on-brand in light
// and dark by construction -- but the outline surface still can't be uglified,
// because the anti-ugly guarantee is enforced by SPACE (the node-decoration
// budget, NodeDecorations) and CONTAINMENT (the Tier-3 panel, ctx.openPanel),
// not by restricting which components exist.
//
// Why a barrel and not direct `@/components/ui/*` imports: it names ONE blessed
// roster (lint-enforced for `src/plugins/**` -- see .oxlintrc.json), so the set
// a plugin author reaches for is a deliberate, reviewable list rather than "all
// of components/ui". Deliberately EXCLUDED: app-shell chrome (sidebar), core
// surfaces (command/cmdk, sonner) -- those are the app's, not a plugin's.
//
// Add a component here only when a plugin needs it; that keeps the surface a
// decision, not a dumping ground.

export * from "@/components/ui/badge";
export * from "@/components/ui/badge-variants";
export * from "@/components/ui/button";
export * from "@/components/ui/button-variants";
export * from "@/components/ui/card";
export * from "@/components/ui/checkbox";
export * from "@/components/ui/dialog";
export * from "@/components/ui/dropdown-menu";
export * from "@/components/ui/input";
export * from "@/components/ui/separator";
export * from "@/components/ui/sheet";
export * from "@/components/ui/skeleton";
export * from "@/components/ui/switch";
export * from "@/components/ui/tabs";
export * from "@/components/ui/textarea";
export * from "@/components/ui/tooltip";
