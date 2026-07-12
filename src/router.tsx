import { createRouter } from "@tanstack/react-router";

import { ErrorScreen } from "./components/error-screen";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // A render error shows a humane screen and reports to Sentry (#227),
    // instead of a white page.
    defaultErrorComponent: ErrorScreen,
  });

  return router;
}
