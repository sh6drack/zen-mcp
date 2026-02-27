# zen-mcp

MCP server for **Zen Browser** automation. The first Model Context Protocol server built for Zen.

Connects directly to Zen's WebDriver BiDi protocol over WebSocket, giving AI agents full browser control — navigate pages, fill forms, click elements, run JavaScript, take screenshots, and more.

## Why

Zen Browser is Firefox-based. The existing [chrome-devtools-mcp](https://github.com/anthropics/claude-code) only works with Chrome/Chromium. Zen doesn't support the Chrome DevTools Protocol (CDP) — it uses **WebDriver BiDi**, a W3C standard for browser automation.

zen-mcp speaks BiDi natively. No Selenium. No Playwright. No browser driver binaries. Just a direct WebSocket connection.

## Quick Start

### 1. Install

```bash
git clone https://github.com/sh6drack/zen-mcp.git
cd zen-mcp
npm install
```

### 2. Launch Zen with remote debugging

```bash
/Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port 9222
```

Or use the included helper:

```bash
./launch-zen.sh
```

### 3. Add to Claude Code

Add to `~/.claude/mcp_servers.json`:

```json
{
  "mcpServers": {
    "zen-browser": {
      "command": "node",
      "args": ["/path/to/zen-mcp/server.mjs"],
      "env": {
        "ZEN_DEBUG_PORT": "9222"
      }
    }
  }
}
```

Then add permissions in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__zen-browser__*"]
  }
}
```

Start a new Claude Code conversation. The `zen_*` tools will be available.

## Tools

| Tool | Description |
|------|-------------|
| `zen_list_pages` | List all open tabs with URLs and titles |
| `zen_select_page` | Switch active tab by index |
| `zen_new_tab` | Open a new tab, optionally with a URL |
| `zen_navigate` | Navigate to a URL |
| `zen_snapshot` | Structured page snapshot with CSS selectors (filter: all/interactive/form) |
| `zen_screenshot` | Capture page screenshot |
| `zen_click` | Click an element by CSS selector |
| `zen_fill` | Fill a text input or textarea (framework-compatible event dispatching) |
| `zen_select_option` | Select a dropdown option by value or text |
| `zen_check` | Check/uncheck a checkbox or radio button |
| `zen_evaluate` | Execute JavaScript in the page context |
| `zen_get_form_fields` | List all form fields with types, labels, values, and selectors |
| `zen_fill_form` | Batch fill multiple form fields (fill/select/check/click) |
| `zen_scroll` | Scroll the page or scroll an element into view |
| `zen_wait` | Wait for a specified time |

## How It Works

```
Claude Code  <-->  zen-mcp (MCP/stdio)  <-->  Zen Browser (BiDi/WebSocket)
```

1. Claude Code starts zen-mcp as a child process, communicating over stdio using MCP protocol
2. zen-mcp connects to Zen's WebDriver BiDi server at `ws://127.0.0.1:9222/session`
3. Tool calls are translated to BiDi commands (`browsingContext.navigate`, `script.callFunction`, `browsingContext.captureScreenshot`, etc.)
4. DOM interactions use `script.callFunction` with native value setters and proper event dispatching for React/Angular/Vue compatibility

### Key Details

- **Protocol**: WebDriver BiDi (W3C standard), not CDP
- **WebSocket endpoint**: `ws://127.0.0.1:{port}/session` (Firefox/Zen puts BiDi at `/session`, not root)
- **Session management**: Creates a BiDi session on first tool call, cleans up on exit
- **Form filling**: Uses native `HTMLInputElement.prototype.value` setter + `input`/`change` event dispatch for framework compatibility
- **No dependencies on browser drivers** — just `ws` for WebSocket and `@modelcontextprotocol/sdk` for MCP

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ZEN_DEBUG_PORT` | `9222` | Port for Zen's remote debugging server |

### Zen Launch Flags

```bash
# Basic
/Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port 9222

# With security restrictions (recommended for production)
/Applications/Zen.app/Contents/MacOS/zen \
  --remote-debugging-port 9222 \
  --remote-allow-hosts localhost,127.0.0.1 \
  --remote-allow-origins '*'
```

**Tip**: Add an alias to your shell config:

```bash
alias zen='open /Applications/Zen.app --args --remote-debugging-port 9222'
```

## Requirements

- [Zen Browser](https://zen-browser.app/) (any version)
- Node.js 20+
- macOS, Linux, or Windows (paths in examples are macOS)

## Test

```bash
# Make sure Zen is running with --remote-debugging-port 9222
node test-e2e.mjs
```

## License

MIT
