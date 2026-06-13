# zen-mcp

The first MCP server for **Zen Browser**. Automate Zen from Claude Code, Cursor, or any MCP client.

No Selenium. No Playwright. No browser drivers. Just WebSocket.

## Setup (2 minutes)

### 1. Start Zen with remote debugging — on a throwaway profile

> **Security:** run zen-mcp against a **dedicated, disposable profile**, not your
> everyday Zen. The agent can read page content and form values and navigate
> anywhere the browser is logged in — keep it away from your real cookies and
> sessions. The launcher below does this and runs **alongside** your normal Zen
> without killing it.

```bash
./launch-zen.sh        # or: npm run launch-zen
```

This starts Zen with a throwaway profile (`/tmp/zen-mcp`) and
`--remote-debugging-port 9222 --no-remote`. To do it by hand:

```bash
/Applications/Zen.app/Contents/MacOS/zen \
  --profile /tmp/zen-mcp --remote-debugging-port 9222 --no-remote
```

> `--no-remote` is required if your daily Zen is already running, otherwise the
> new flags are handed to (and ignored by) the existing instance.
>
> By default the launcher runs a renamed copy named **Zen MCP**, so the
> automation browser is visually distinct from your daily Zen in the app switcher
> / Dock. On first run it copies `Zen.app` to `~/Applications/Zen MCP.app` (APFS
> clone, ~0 extra disk; rebuilt only when Zen updates) — only the filename
> changes, so the signature stays valid and it launches normally. (Isolation
> comes from the throwaway profile above, not this copy; the copy is just for
> visual clarity.) To skip the copy and launch the system Zen, set
> `ZEN_APP_NAME=` (empty), or point `ZEN_BIN` at your own binary.

### 2. Add to Claude Code

```bash
# Option A: npm (recommended)
npm install -g zen-mcp

# Option B: Clone
git clone https://github.com/sh6drack/zen-mcp.git && cd zen-mcp && npm install
```

Add to `~/.claude/mcp_servers.json`:

```json
{
  "mcpServers": {
    "zen-browser": {
      "command": "zen-mcp"
    }
  }
}
```

> If you cloned instead of npm install, use `"command": "node", "args": ["/absolute/path/to/zen-mcp/server.mjs"]`

Add to `~/.claude/settings.json`. **Don't blanket-allow every tool** — auto-allow
only the read-only ones and let the powerful tools prompt:

```json
{
  "permissions": {
    "allow": [
      "mcp__zen-browser__zen_list_pages",
      "mcp__zen-browser__zen_snapshot",
      "mcp__zen-browser__zen_screenshot",
      "mcp__zen-browser__zen_get_page_text",
      "mcp__zen-browser__zen_get_form_fields"
    ]
  }
}
```

> Tools left out of `allow` (notably `zen_evaluate` and `zen_navigate`) will
> prompt for approval each time. Avoid the old `["mcp__zen-browser__*"]` wildcard:
> it auto-approves everything, including `zen_evaluate`, which runs arbitrary
> JavaScript in the page. Treat page content as untrusted (prompt injection).
>
> **OpenCode** users gate tools in `opencode.json` instead — see [Security](#security).

**That's it.** Start a new Claude Code session and the `zen_*` tools are available.

## 20 Tools

### Browse

| Tool | What it does |
|------|-------------|
| `zen_navigate` | Go to a URL |
| `zen_list_pages` | List all open tabs |
| `zen_select_page` | Switch to a tab |
| `zen_new_tab` | Open a new tab |
| `zen_close_tab` | Close a tab |

### See

| Tool | What it does |
|------|-------------|
| `zen_snapshot` | Page structure with selectors (filter: all/interactive/form) |
| `zen_screenshot` | Capture a screenshot |
| `zen_get_page_text` | Get page title, URL, and text |
| `zen_get_form_fields` | List all form fields with labels and values |

### Interact

| Tool | What it does |
|------|-------------|
| `zen_click` | Click an element |
| `zen_fill` | Type into an input or textarea |
| `zen_select_option` | Pick a dropdown option |
| `zen_check` | Toggle a checkbox or radio |
| `zen_press_key` | Keyboard input (Enter, Tab, Ctrl+A, etc.) |
| `zen_fill_form` | Fill multiple fields at once |
| `zen_scroll` | Scroll the page or to an element |

### Utility

| Tool | What it does |
|------|-------------|
| `zen_evaluate` | Run JavaScript in the page |
| `zen_wait` | Wait N milliseconds |
| `zen_wait_for` | Wait for text or element to appear |
| `zen_reconnect` | Force reconnect to Zen |

## How It Works

```
Claude Code  ──stdio/MCP──>  zen-mcp  ──WebSocket/BiDi──>  Zen Browser
```

zen-mcp speaks **WebDriver BiDi** (W3C standard) directly over WebSocket. Form filling uses native value setters with `input`/`change` event dispatch so React, Vue, and Angular apps work correctly.

### What Works Well

- **Navigation, clicking, form filling** — rock solid, handles React/Vue/Angular
- **Screenshots and page reads** — reliable content extraction
- **Tab management** — open, close, switch between tabs
- **JavaScript evaluation** — run any code in the page context
- **Keyboard input** — shortcuts, Enter, Tab, modifier combos

### Known Limitations

- Zen inherits Firefox's WebDriver BiDi implementation, which is still maturing. Some advanced BiDi commands that work in Chrome may not be available yet.
- Zombie sessions can only be cleared by restarting Zen (BiDi session.end is connection-scoped). zen-mcp detects this and tells you what to do.
- No file upload or drag-and-drop support (BiDi spec limitation).

### Built-in Reliability

- **Auto-reconnect** with exponential backoff if WebSocket drops
- **Zombie session recovery** when a previous client crashed
- **Connection retry** (3 attempts with backoff)
- **Clean shutdown** on SIGINT/SIGTERM to prevent orphaned sessions

## Security

This server hands an LLM agent control of a real browser, so treat it with care:

- **Use a throwaway profile** (the launcher does this). Never point it at your
  everyday Zen profile with its logged-in sessions.
- **Web pages are untrusted input.** A malicious page can try to steer the agent
  (prompt injection) into navigating somewhere sensitive or running JS. Keep
  approval prompts on for `zen_evaluate` and `zen_navigate`.
- **Always-on protections:** navigation is restricted to `http`/`https`/`about:blank`
  (no `file:`/`data:`/`chrome:`/etc.), and `password` and hidden field values are
  redacted before being returned to the agent.
- **Optional hardening (env):** `ZEN_BLOCK_PRIVATE_HOSTS=1` blocks loopback/intranet
  navigation; `ZEN_REDACT_URLS=1` strips query strings (which can carry tokens)
  from URLs returned to the agent. See [Config](#config).
- **OpenCode:** gate tools in `opencode.json`, e.g. disable arbitrary JS with
  `"tools": { "zen-browser_zen_evaluate": false }`, or prompt via a `"permission"`
  rule.

The server connects only to `127.0.0.1` and sends no telemetry; the only data
that leaves your machine is whatever the agent reads from pages and returns to
your MCP client/LLM.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot connect to Zen Browser" | Start Zen with `./launch-zen.sh` (or pass `--remote-debugging-port 9222`) |
| "Maximum number of active sessions" | Quit the debug Zen instance and re-run `./launch-zen.sh` |
| Connection keeps dropping | Use `zen_reconnect` to force a fresh connection |

## Config

### Server (`server.mjs`)

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ZEN_DEBUG_PORT` | `9222` | Zen's remote debugging port to connect to |
| `ZEN_BLOCK_PRIVATE_HOSTS` | `off` | When set (`1`/`true`), block navigation to loopback/private/link-local/intranet hosts (e.g. `localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `*.local`). Leave off to automate local dev servers. |
| `ZEN_REDACT_URLS` | `off` | When set (`1`/`true`), strip query strings and fragments from URLs returned to the LLM (which often carry OAuth codes, reset tokens, signed-URL params). Leave off if the agent needs full URLs. |

### Launcher (`launch-zen.sh`)

The launcher starts Zen on an isolated throwaway profile **alongside** your daily
browser — it never kills any running Zen, reuses an instance already on the port
instead of launching a duplicate, and reports a failed start (e.g. a profile lock).

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ZEN_DEBUG_PORT` | `9222` | Remote debugging port to launch on |
| `ZEN_PROFILE` | `/tmp/zen-mcp` | Throwaway profile directory (kept free of personal logins) |
| `ZEN_BIN` | system Zen | Explicit Zen executable to launch; overrides the `ZEN_SRC_APP`/`ZEN_APP_*` options below |
| `ZEN_SRC_APP` | `/Applications/Zen.app` | Source Zen.app to launch (and to copy from for `ZEN_APP_NAME`) |
| `ZEN_APP_NAME` | `Zen MCP` | Launch a renamed **copy** of Zen.app under this name so the automation instance is visually distinct in the app switcher / Dock. Copies by filename only — `Info.plist`/signature untouched — rebuilt only on Zen version change. Set empty (`ZEN_APP_NAME=`) to launch the system Zen with no copy |
| `ZEN_APP_DIR` | `~/Applications` | Where the `ZEN_APP_NAME` copy is kept |

> The app-switcher name follows the bundle **filename** (Zen ships no
> `CFBundleDisplayName`); the menu-bar name and icon stay Zen's. Don't edit the
> copy's `Info.plist` or icon — those are sealed by the code signature, and
> changing them makes macOS refuse to launch it.

## Requirements

- [Zen Browser](https://zen-browser.app/)
- Node.js 20+

## Test

```bash
node test-e2e.mjs   # 21 tests, needs Zen running
```

## License

MIT
