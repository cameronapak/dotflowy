import { useRef } from "react";
import { CheckIcon, PaletteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  previewThemePreset,
  useThemePreset,
} from "@/components/theme-provider";
import { THEME_PRESETS, type ThemePreset } from "./presets";

/** Four overlapping dots previewing a preset's palette. Colors are raw oklch
 *  strings, so they render straight from the catalog with no derivation. */
function Swatch({ swatch }: { swatch: ThemePreset["swatch"] }) {
  const dots = [swatch.background, swatch.primary, swatch.accent, swatch.border];
  return (
    <span className="flex items-center -space-x-1">
      {dots.map((c, i) => (
        <span
          key={i}
          className="size-3 rounded-full ring-1 ring-border ring-inset"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}

/**
 * Header-slot color-theme picker (Seam F-header). Click commits; hovering a
 * row previews it live (the apply is just a `data-theme` swap -- instant, zero
 * React churn). Dismissing without a click restores the committed preset.
 */
export function ThemePicker() {
  const { preset, setPreset } = useThemePreset();
  // True once a row was clicked this open-session, so the dismiss handler
  // doesn't revert the just-committed preview before the store effect lands.
  const committedThisOpen = useRef(false);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          committedThisOpen.current = false;
        } else if (!committedThisOpen.current) {
          previewThemePreset(preset); // restore on dismiss-without-commit
        }
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm">
            <PaletteIcon />
            <span className="sr-only">Color theme</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Color theme</DropdownMenuLabel>
          {THEME_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onPointerEnter={() => previewThemePreset(p.id)}
              onClick={() => {
                committedThisOpen.current = true;
                setPreset(p.id);
              }}
            >
              <Swatch swatch={p.swatch} />
              <span className="truncate">{p.label}</span>
              {p.id === preset && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
