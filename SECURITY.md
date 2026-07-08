# Security Policy

Claude Code Orchestrator is an unofficial VS Code extension that coordinates multiple Claude Code accounts. Because it operates near your Claude accounts, we take its security boundary seriously.

## Security model

The extension is designed around one hard rule:

> **It never reads, stores, or transmits Claude account tokens or credentials.**

Each worker account is simply a separate Claude Code configuration directory (e.g. `~/.claude-<name>`). You sign in once through the Claude Code CLI, and the CLI owns login, token storage, and refresh from then on. The extension only sets `CLAUDE_CONFIG_DIR` and invokes the CLI — it does not touch the login flow, and it has no code path that inspects credential files.

If you find any behavior that contradicts this, please treat it as a security vulnerability and report it privately.

## Supported versions

Security fixes are applied to the latest released version. Please upgrade to the newest version before reporting, in case the issue is already fixed.

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the advisory form with as much detail as you can.

This keeps the report private between you and the maintainers until a fix is available.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- The extension version and your VS Code / OS version.
- Any relevant configuration (with **all** tokens, credentials, and personal data removed).

## What to expect

- We aim to acknowledge a report within a few days.
- We'll work with you to understand and confirm the issue.
- Once a fix is released, we'll credit you in the advisory unless you prefer to remain anonymous.

## Scope

In scope:

- The extension code in this repository (dispatch, MCP server, dashboard, usage tracking).
- Any way the extension could leak, mishandle, or expose account credentials or data.

Out of scope:

- Vulnerabilities in Claude Code itself, the Claude API, or Anthropic's services — please report those to Anthropic.
- Issues that require a pre-compromised machine or malicious local user with existing filesystem access.

Thank you for helping keep the community safe.
