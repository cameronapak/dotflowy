---
name: wasp-plugin-help
description: Shows the Wasp plugin's available features, commands, and skills.
---

1. run the [check-wasp-init hook](../../hooks/check-wasp-init.js) using the Bash tool with `node` command to check if the Wasp plugin has been initialized.
2. let the user know if the Wasp plugin has been initialized or not.
3. if the Wasp plugin has not been initialized (the hook outputs JSON), let the user know they should take care of this first by running `/wasp-plugin-init`:

```markdown
⚠️
The Wasp plugin hasn't been initialized for the current project.
Run `/wasp-plugin-init` to get the plugin's full functionality.
```

4. display the [Wasp Plugin for Claude Code](#wasp-plugin-for-claude-code) section to the user exactly as it is below.

--- --- 🐝 🐝 🐝 --- ---

# 🐝 Wasp Plugin for Claude Code

## What This Plugin Does

This plugin makes Claude Code, Codex, Copilot, etc. work better with Wasp by:

1. **Using the right documentation** — Automatically fetches the correct Wasp docs for your project's version
2. **Avoiding common mistakes** — Provides Wasp-specific tips, patterns, and best practices so the agent doesn't hallucinate or use outdated approaches
3. **Guided workflows** — Skills and commands so the agent can walk you through setting up Wasp's batteries-included features (auth, email, database, styling) and deploying
4. **Full debugging visibility** — Start managed databases, dev servers, and connect browser console access so the agent has full development and debugging visibility across the entire stack

The result: The agent actually understands Wasp instead of guessing.

## Quick Reference

Skills:
`add-feature` - Add Wasp's built-in features (auth, email, database, styling)
`deploying-app` - Guided deployment to Railway or Fly.io
`expert-advice` - Get advice on app improvements and functionality from a Wasp expert
`start-dev-server` - Start dev environment with full debugging visibility (db -> server -> browser console)
`wasp-plugin-init` - Adds Wasp knowledge, LLM-friendly documentation fetching instructions, and best practices to your project's CLAUDE.md or AGENTS.md file

## 💬 Example Prompts

- _"Add Google authentication to my app"_
- _"Help me add ShadCN UI to my app"_
- _"Migrate the database from SQLite to PostgreSQL and start it for me"_
- _"Set up email sending with SendGrid"_
- _"Solve the errors in the browser using the Chrome DevTools MCP server"_
- _"Why isn't my recurring job working?"_
- _"Deploy my app to Railway"_

## 📖 Documentation Access

The plugin ensures Claude detects your project's Wasp version and references the correct, LLM-friendly documentation.

## 🫂 Community & Contribute

Join the [Wasp Discord](https://discord.gg/rzdnErX) for help and web dev discussion.
Submit issues, feedback, or PRs: [Wasp Agent Plugins](https://github.com/wasp-lang/wasp-agent-plugins)
