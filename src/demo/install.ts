import { installDemoBackend, isDemoBoot } from "./backend";

// Side-effect module, imported first in the root route so the demo backend is
// in place before the session check or the sync socket can reach the Worker.
if (isDemoBoot()) {
  installDemoBackend();
  // The app stops overscroll at the page edge. Framed in the landing page,
  // that traps the wheel: let a scroll that reaches the end move the landing.
  document.documentElement.style.overscrollBehavior = "auto";
}
