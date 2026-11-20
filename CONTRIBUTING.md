# Contributing to Agent Glasses

Thanks for helping. Agent Glasses is a small, dependency-light VS Code extension; this page covers how to
run it, test it and send a change.

## Ways to help

- **Report a bug:** open an [issue](https://github.com/nimeus/agent-glasses/issues/new/choose) with your OS,
  VS Code version, Agent Glasses version and what you saw. Reports from **Windows and Linux** are especially
  useful: those platforms have had little real-world use.
- **Suggest a feature:** open an issue first, so we can agree on it before you write code.
- **Fix something:** pick an issue (say you are taking it) or send a small pull request directly.

Never paste transcript content, API keys or phone device keys into an issue. Security problems go
through private reporting, see [docs/SECURITY.md](docs/SECURITY.md#reporting).

## Set up

Needs Node.js 20+, git and VS Code.

```bash
git clone https://github.com/<you>/agent-glasses.git
cd agent-glasses
npm ci
code .
```

Press **F5** (or **Run → Start Debugging**, "Run Agent Glasses"). A second VS Code window, the Extension
Development Host, opens with your copy loaded. It reads the real transcripts in `~/.claude/projects`, so
you see your own sessions. After editing:

- `extension.js` or `lib/*`: restart the debug session (⇧⌘F5 / Ctrl+Shift+F5).
- `media/*` (the panel): run **Developer: Reload Webviews** in the development window.

To try a packaged build: `npm run package`, then `code --install-extension agent-glasses-<version>.vsix`.
Bump `version` in `package.json` first, or VS Code keeps the old copy loaded.

## Project layout

| Path | What it is |
|---|---|
| `extension.js` | VS Code wiring: views, status bar, alerts, messages from the webview. |
| `lib/` | Plain Node modules with no VS Code imports: transcript parsing, statistics, insights, git, search, phone server. Easy to test in isolation. |
| `media/view.js`, `view.css` | The panel. Plain DOM, no framework, no build. |
| `media/phone/` | The phone page. |
| `scripts/` | Status-line and Notification-hook scripts users copy into `~/.claude`, plus `check.mjs`. |
| `tests/` | `node:test` tests. |
| `docs/` | Architecture, security model, changelog. |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how data flows from transcripts to the panel.

## Tests and checks

```bash
npm run check   # node --check on every source file
npm test        # unit tests (node:test)
```

Both run in CI on macOS, Windows and Linux for every pull request.

- Add a test in `tests/` for logic you change in `lib/` (parsing, cost maths, coach rules, security).
- `tests/phone.test.cjs` starts the real phone server on a private LAN address and checks pairing, keys,
  revocation and rate limits. It is skipped on machines without one (such as CI runners). VS Code runs
  extensions in Electron, whose TLS library differs from Node's; to test there too:
  `ELECTRON_RUN_AS_NODE=1 "<path to VS Code's executable>" --test tests/phone.test.cjs`.
- For UI changes, include a screenshot of the panel (light and dark theme if colours changed).

## Code guidelines

- **No new runtime dependencies** without discussing it in an issue. Node's standard library is preferred.
- **Cross-platform:** use `path.join`, `os.homedir()`, and check `process.platform` before calling a
  platform tool (`ps`, `vm_stat`, `tasklist`…). Spawn programs with `execFile` and an argument array,
  never a shell string.
- **Never render transcript text as HTML.** Build the DOM with `textContent` (see the Markdown renderer
  in `media/view.js`). Mask secrets with `data.redact()` before showing or exporting text.
- **Read-only by default.** Anything that writes outside `~/.claude/agent-glasses/` must ask first and keep
  a backup. Anything that reaches the network must be off by default.
- **Keep it fast:** the live view refreshes every 2 seconds. Read files incrementally, cache by size and
  mtime, and stream large transcripts.
- Match the existing style: 2-space indent, single quotes, semicolons, a short comment explaining *why*
  above anything non-obvious.
- UI text: short, plain sentences; say what happened and what to do.

## Pull requests

1. Branch from `main`, keep the change focused, one topic per pull request.
2. Run `npm run check` and `npm test`.
3. Add a line under **Unreleased** in [docs/CHANGELOG.md](docs/CHANGELOG.md).
4. Update the README or docs if behaviour, settings or security change.
5. Describe what changed, why, and how you tested it (OS included).

By contributing you agree that your work is released under the [MIT License](LICENSE).

## Releases (maintainer)

Bump `version` in `package.json`, move **Unreleased** in the changelog under the new version, commit,
then tag and push: `git tag v<version> && git push origin v<version>`. Two workflows run on the tag:

- `ci.yml` tests on three platforms, packages the `.vsix` and attaches it to a GitHub release.
- `publish.yml` publishes to the VS Code Marketplace with Trusted Publishing (no stored secret) and, when
  the `OVSX_PAT` secret is set, to Open VSX. It runs in the `marketplace` environment.
