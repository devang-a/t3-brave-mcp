# t3-brave-mcp

A lightweight, security-scoped **Brave / Chromium MCP bridge** that lets AI coding agents (Claude Code, Codex, Antigravity, or any stdio MCP client) control tabs in your **existing signed-in browser profile** — without launching Chrome with a wide-open `--remote-debugging-port` and without exporting cookies.

## Why this exists

Most browser-agent integrations force a bad trade-off:
- **Isolated browser profiles:** you're logged out of every site and constantly blocked by 2FA, OAuth, and CAPTCHAs.
- **Global `--remote-debugging-port`:** exposes *every* tab and session in your personal browser to any local process.

`t3-brave-mcp` takes a hybrid, per-tab approach using Chrome's `chrome.debugger` API behind an authenticated loopback WebSocket bridge:

- **Hands-free allowlisted auto-open (`browser_open_tab` / `browser_close_tab`):** Configure trusted domains in the extension popup (e.g. `*.example.com`). Agents can quietly open background tabs on allowlisted sites using your live sessions, stay attached across OAuth redirects, and close only tabs they opened.
- **One-click / hotkey live tab handoff (`⌥⇧T` / `Alt+Shift+T`):** Halfway through a random one-off form or portal you don't want to whitelist? Press `Alt+Shift+T` (or click **Hand off** in the popup) to attach the agent to your exact live DOM state, then click `×` when done.
- **Multi-agent CDP multiplexing:** Multiple parallel agents can share the bridge concurrently — each MCP session pins its own `targetId` in memory (no shared-file tab clobbering) and shares cached `Runtime.executionContextCreated` events without resetting peer sessions.
- **Strict local security model:** Authenticated `127.0.0.1` loopback bridge (`Bearer` token), strict `chrome-extension://` origin verification on `/extension`, webpage-origin rejection, per-tab `chrome.debugger` scoping, and zero cookie extraction.

## Architecture

```text
MCP Client (Claude / Codex / Antigravity)
   └── stdio MCP (mcp.mjs)  ──  per-session targetId pin + Playwright MCP
          └── Authenticated Loopback Bridge (bridge.mjs + cdp-relay.mjs, 127.0.0.1:9334)
                 └── MV3 Extension (extension/worker.js)  ──  per-tab chrome.debugger
                        └── Explicitly handed-off or allowlist-opened Brave tabs
```

## Quick Start

Requires **Node.js 22+**.

```sh
git clone https://github.com/Thenewbiehacker/t3-brave-mcp.git
cd t3-brave-mcp
npm ci
```

### 1. Start the local bridge (or install macOS LaunchAgent)

Run in the foreground:
```sh
npm start
```

Or on macOS, install the background LaunchAgent (`local.t3-brave-mcp.bridge`, auto-starts at login):
```sh
node scripts/install-service.mjs install
node scripts/install-service.mjs status
```

First run creates a 256-bit local pairing token at `~/.t3/brave-bridge/token`.

### 2. Load the MV3 extension in Brave (or Chrome)

1. Open `brave://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repo's `extension/` folder.
3. Open the **T3 Brave Bridge** popup, click the gear icon, paste the token from `~/.t3/brave-bridge/token`, and click **Save**.
4. Add any domains you want hands-free auto-open for under **Allowed sites** (or optionally seed them via `~/.t3/brave-bridge/allowlist.json`, e.g. `["*.example.com"]`).

### 3. Register the MCP server with your agent client

- **Claude Code:**
  ```sh
  claude mcp add --scope user brave -- node /absolute/path/to/t3-brave-mcp/mcp.mjs
  ```
- **Codex:**
  ```sh
  codex mcp add brave -- node /absolute/path/to/t3-brave-mcp/mcp.mjs
  ```
- **Antigravity / generic MCP `mcp_config.json`:**
  ```json
  {
    "mcpServers": {
      "brave": {
        "command": "node",
        "args": ["/absolute/path/to/t3-brave-mcp/mcp.mjs"]
      }
    }
  }
  ```

Restart your agent session so the new `brave` tools appear.

## Exposed MCP Tools

- `browser_backend`: Report/select `brave` vs `preview` mode, check `extensionConnected`, view the active `allowlist` and attached `targetId`s, and pin a `targetId` for the current session.
- `browser_open_tab`: Open (or reuse) an allowlisted `http(s)` URL in Brave (background by default), attach it, and pin its `targetId` for this session.
- `browser_close_tab`: Close an agent-opened tab (refuses to close user-opened personal tabs).
- Standard Playwright MCP `browser_*` tools (`browser_snapshot`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_take_screenshot`, etc.), excluding destructive browser-level actions (`browser_close`, `browser_install`, `browser_run_code`).

## State & Logs

Runtime state stays outside the repo in `~/.t3/brave-bridge/`:
- `token`: local pairing secret (`0600`)
- `config.json`: loopback endpoint + token (`0600`)
- `selection.json`: `brave` / `preview` backend preference
- `allowlist.json` *(optional)*: JSON array of domain patterns to seed on first connect
- `bridge.log` / `bridge-error.log`: timestamped lifecycle logs (never logs tokens)

## Testing

```sh
npm test            # Unit tests for bridge, auth/origin guards, multiplexing, backend & service
npm run test:brave  # End-to-end smoke test in a disposable Brave profile
```

## License

MIT — see [LICENSE](./LICENSE). `cdp-relay.mjs` is adapted from T3 Code's MIT-licensed `CdpRelay.ts`; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
