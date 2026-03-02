# zen-mcp

The first MCP server for **Zen Browser**. Automate Zen from Claude Code, Cursor, or any MCP client.

No Selenium. No Playwright. No browser drivers. Just WebSocket.

## Setup (2 minutes)

### 1. Start Zen with remote debugging

```bash
/Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port 9222
```

> **Pro tip**: Add `alias zen='open /Applications/Zen.app --args --remote-debugging-port 9222'` to your shell config. Then just run `zen`.

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

Add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__zen-browser__*"]
  }
}
```

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot connect to Zen Browser" | Start Zen with `--remote-debugging-port 9222` |
| "Maximum number of active sessions" | Restart Zen: `killall zen && zen` |
| Connection keeps dropping | Use `zen_reconnect` to force a fresh connection |

## Config

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ZEN_DEBUG_PORT` | `9222` | Zen's remote debugging port |

## Requirements

- [Zen Browser](https://zen-browser.app/)
- Node.js 20+

## Test

```bash
node test-e2e.mjs   # 21 tests, needs Zen running
```

## License

MIT
