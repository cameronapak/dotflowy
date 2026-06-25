// Set the `dark` class before first paint so the page never flashes the wrong
// theme on reload. Mirrors theme-provider.tsx's resolution + storage key. Loaded
// as a render-blocking <script src> from the document head (see main.wasp.ts) --
// it lives in a real file, not an inline head string, because Wasp parses head
// entries as JSX and an inline script's braces/`</script>` break that.
(function () {
  try {
    var t = localStorage.getItem("dotflowy-oss:theme") || "system";
    var dark =
      t === "dark" ||
      (t === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (e) {}
})();
