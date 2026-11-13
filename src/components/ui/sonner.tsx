"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

import {
  CircleCheckIcon,
  ErrorIcon,
  InfoIcon,
  LoaderIcon,
  WarningIcon,
} from "@/lib/icons";

import { useTheme } from "../theme-provider";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    // SAFETY: useTheme returns "light" | "dark" | "system", which is ToasterProps["theme"]
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <ErrorIcon className="size-4" />,
        loading: <LoaderIcon className="size-4 animate-spin" />,
      }}
      style={
        // SAFETY: CSS custom-property values React.CSSProperties does not type
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
