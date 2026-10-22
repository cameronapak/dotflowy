# dotflowy

## 0.2.0

### Minor Changes

- b143186: Add scoped, cursor-based, and safely aggregated paginated search options.
- 2a66ed4: Accept Embed kind in structured node responses. Create an Embed with `--kind embed` and a single HTTPS URL.
- 937697a: Expose node lock state and reject CLI or MCP mutations that would alter a locked subtree.

### Patch Changes

- 0893622: Report the installed package version in the CLI and MCP client after a release.
- 48fa52b: Document npm installation of the published CLI.
- b9a292b: Upgrade Effect and its Node platform packages to the stable v4 release.

## 0.1.0

### Minor Changes

- Initial release of the Dotflowy CLI with full MCP tool access, browser login,
  OS credential storage, and JSON output for scripts.
