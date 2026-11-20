# Security

## What Agent Glasses can reach

Transcripts can contain source code, file contents and secrets that passed through a tool. Agent Glasses
reads them locally and never sends them off the machine, with one exception you control: phone access.

## Phone access: threat model

**Goal:** let devices you paired view session data over your local network, and nobody else.

| Threat | Mitigation |
|---|---|
| Someone else on the Wi-Fi opens the page | Every request needs a paired device's key; unpaired requests get a 401 with no data. |
| Pairing code is seen or guessed | 192-bit random code, single use, expires after 10 minutes; checked in constant time. Opening the link only shows a confirmation; the code is used up by tapping **Pair**. Reopening a used link redirects to the main page, which still requires a key. |
| A device key is stolen from the server | Only SHA-256 hashes of keys are stored (`~/.claude/claude-viz/phone/devices.json`, mode 600). |
| A lost phone keeps access | Revoke it in **System → Phone access**; its next request gets a 401. |
| Traffic is read on the network | HTTPS (TLS 1.2+) with an RSA-2048 certificate made by the extension itself in Node, with no external tools (key file mode 600). Compare the fingerprint shown in VS Code with the one your phone shows when you first connect. |
| Brute force | 10 failed attempts from one address block it for 10 minutes. |
| The service is left running | Off by default; turns itself off after `agentGlasses.phone.autoOffHours` (default 4). |
| Exposure beyond the LAN | Binds only to private IPv4 addresses (10/8, 172.16/12, 192.168/16) on physical interfaces; loopback, VPN, virtual-machine and container adapters are skipped (macOS, Linux and Windows names). Never `0.0.0.0`. On Windows and Linux, allow the port in the firewall for private networks only. Nothing is forwarded to the internet. |
| The page is abused to change things | GET only (others get 405); the API has no write endpoints. |
| Cross-site attacks against the page | Key cookie is `HttpOnly; Secure; SameSite=Strict`. Responses send a strict Content-Security-Policy (`default-src 'none'`, scripts only from the page itself), `X-Frame-Options: DENY`, `no-store`, `nosniff`, `no-referrer`. |
| Transcript text runs as code on the phone | The phone page builds the DOM with `textContent` only; links open with `noopener`. |

**Residual risks:** a self-signed certificate depends on you checking the fingerprint once; someone with
your unlocked paired phone can view the page until you revoke it; anyone with access to your Mac account
can read the transcripts directly anyway.

## Other actions that change things

- **Unblock coach** adds a permission rule only after a confirmation that names the rule and the file,
  and keeps a backup (`*.bak-agent-glasses`). Broad commands (`rm`, `sudo`, `git push`, bare interpreters…)
  are offered as copy-only.
- **Worktree cleaner** removes only agent worktrees (`.claude/worktrees/*`) that are clean, merged and
  unlocked, re-checks just before removing, and uses `git worktree remove` without `--force`; branches are
  kept.
- Links in rendered Markdown open through VS Code, which asks before opening an external site.
- **Git in session folders** (worktree scan, session git view): every automatic `git` call disables
  `core.fsmonitor` and hooks, which a repository's own config could otherwise use to run programs. Filter
  drivers defined in `.gitattributes` can still run during `git status`; the scans only touch folders where
  you ran Claude Code yourself.
- **Copied commands** (`claude --resume`) quote the folder for the shell and accept only plain session ids.

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the
repository's Security tab, not in a public issue. Do not include transcript content or keys. For anything
that is not a vulnerability, open a normal issue.
