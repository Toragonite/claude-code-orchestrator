# Contributing to Claude Code Orchestrator

Thanks for your interest in improving Claude Code Orchestrator! This is a community-maintained, unofficial VS Code extension — contributions of all sizes are welcome, from typo fixes to new dispatch features.

> This project is not affiliated with or endorsed by Anthropic.

## Ways to contribute

- **Report a bug** — open an [issue](https://github.com/Toragonite/claude-code-orchestrator/issues) using the Bug Report template.
- **Request a feature** — open an issue using the Feature Request template.
- **Improve docs** — the README exists in English, Korean, and Simplified Chinese; keeping them in sync is always appreciated.
- **Fix or build something** — see the workflow below.

## Development setup

Requirements:

- Node.js 18+ and npm
- VS Code 1.90+
- [Claude Code](https://claude.com/claude-code) CLI installed and logged in
- At least one additional Claude account to test worker dispatch

```bash
git clone https://github.com/Toragonite/claude-code-orchestrator.git
cd claude-code-orchestrator
npm install
npm run compile      # build once
npm run watch        # or rebuild on change
```

Press `F5` in VS Code to launch an **Extension Development Host** with the extension loaded. To produce an installable build:

```bash
npm run package      # generates a .vsix you can install locally
```

## Making a change

1. **Open an issue first** for anything non-trivial, so we can agree on the approach before you invest time.
2. Create a branch from `main` (e.g. `fix/worker-quota-reset` or `feat/dashboard-filter`).
3. Keep the change focused — one logical change per pull request.
4. Match the existing code style: TypeScript, the conventions already in `src/`. Run `npm run compile` and make sure it builds cleanly with no new type errors.
5. Update the relevant README(s) and any user-facing docs if behavior changes.
6. Open a pull request against `main` using the PR template. Link the issue it closes.

## Pull request expectations

- The build passes (`npm run compile`).
- The change is described clearly, with steps to verify it.
- No credentials, tokens, personal emails, or account data are included in code, commits, or screenshots. See [SECURITY.md](SECURITY.md).
- The extension's core boundary is respected: **it never reads, stores, or transmits Claude account tokens or credentials.** Login and refresh are always delegated to the Claude Code CLI. PRs that cross this line will not be merged.

## Reporting security issues

Please do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Code of conduct

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers this project.
