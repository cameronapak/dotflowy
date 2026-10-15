import { installDemoBackend, isDemoBoot } from "./backend";

/** The demo's home on the landing page. A top-level tab at the app's `/demo`
 *  goes there: the app's own URLs boot the real account on reload, so the
 *  demo only runs where a reload keeps it a demo, inside the named frame. */
const LANDING_DEMO_URL = "https://dotflowy.com/try";

/** Local dev keeps a top-level `/demo` for testing the demo by itself. */
const isLocalDev = () =>
  ["localhost", "127.0.0.1"].includes(window.location.hostname);

// Side-effect module, imported first in the root route so the demo backend is
// in place before the session check or the sync socket can reach the Worker.
if (isDemoBoot()) {
  // Installed even when leaving, so nothing reaches the Worker meanwhile.
  installDemoBackend();
  if (window.top === window && !isLocalDev()) {
    window.location.replace(LANDING_DEMO_URL);
  }
  // The app stops overscroll at the page edge. Framed in the landing page,
  // that traps the wheel: let a scroll that reaches the end move the landing.
  document.documentElement.style.overscrollBehavior = "auto";
}
