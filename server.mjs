#!/usr/bin/env node
/**
 * zen-mcp: MCP server for Zen Browser automation
 * Uses WebDriver BiDi protocol directly via WebSocket.
 *
 * Launch Zen first:
 *   /Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port 9222
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

const PORT = parseInt(process.env.ZEN_DEBUG_PORT || '9222');
const WS_URL = `ws://127.0.0.1:${PORT}/session`;

function log(...args) { console.error('[zen-mcp]', ...args); }

// ─── BiDi Client ────────────────────────────────────────────────────

class BiDiClient {
  ws = null;
  sessionId = null;
  msgId = 0;
  pending = new Map(); // id -> { resolve, reject, timer }
  currentContext = null; // active browsing context

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', async () => {
        log('WebSocket connected');
        try {
          const resp = await this.send('session.new', { capabilities: {} });
          this.sessionId = resp.sessionId;
          log('Session created:', this.sessionId);

          // Get initial contexts
          const tree = await this.send('browsingContext.getTree', {});
          if (tree.contexts?.length > 0) {
            this.currentContext = tree.contexts[0].context;
            log('Active context:', this.currentContext);
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.type === 'error') {
            reject(new Error(msg.error?.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      });

      this.ws.on('error', (e) => {
        log('WebSocket error:', e.message);
        reject(e);
      });

      this.ws.on('close', () => {
        log('WebSocket closed');
        this.ws = null;
        this.sessionId = null;
        // Reject all pending
        for (const [id, { reject, timer }] of this.pending) {
          clearTimeout(timer);
          reject(new Error('Connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async ensureConnected() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
  }

  async getContexts() {
    await this.ensureConnected();
    const tree = await this.send('browsingContext.getTree', {});
    return tree.contexts || [];
  }

  async getActiveContext() {
    await this.ensureConnected();
    if (!this.currentContext) {
      const contexts = await this.getContexts();
      if (contexts.length === 0) throw new Error('No browsing contexts available');
      this.currentContext = contexts[0].context;
    }
    return this.currentContext;
  }

  async navigate(url) {
    const ctx = await this.getActiveContext();
    return this.send('browsingContext.navigate', {
      context: ctx,
      url,
      wait: 'interactive',
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const ctx = await this.getActiveContext();
    return this.send('script.evaluate', {
      expression,
      target: { context: ctx },
      awaitPromise,
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 10 },
    });
  }

  async callFunction(fn, args = []) {
    const ctx = await this.getActiveContext();
    return this.send('script.callFunction', {
      functionDeclaration: fn,
      arguments: args,
      target: { context: ctx },
      awaitPromise: true,
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 10 },
    });
  }

  async screenshot() {
    const ctx = await this.getActiveContext();
    return this.send('browsingContext.captureScreenshot', {
      context: ctx,
    });
  }

  async createTab(url = 'about:blank') {
    await this.ensureConnected();
    const result = await this.send('browsingContext.create', { type: 'tab' });
    const ctx = result.context;
    this.currentContext = ctx;
    if (url !== 'about:blank') {
      await this.send('browsingContext.navigate', { context: ctx, url, wait: 'interactive' });
    }
    return ctx;
  }

  async endSession() {
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
      try {
        await this.send('session.end', {}, 3000);
        log('Session ended cleanly');
      } catch (e) {
        log('Session end error (ok):', e.message);
      }
    }
  }

  async disconnect() {
    await this.endSession();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.sessionId = null;
    }
  }
}

const bidi = new BiDiClient();

// Helper to extract serialized BiDi value
function extractValue(result) {
  if (!result) return undefined;
  const r = result.result || result;
  if (r.type === 'string') return r.value;
  if (r.type === 'number') return r.value;
  if (r.type === 'boolean') return r.value;
  if (r.type === 'null' || r.type === 'undefined') return null;
  if (r.type === 'array') return r.value?.map(extractValue);
  if (r.type === 'object') {
    const obj = {};
    for (const [k, v] of r.value || []) {
      obj[typeof k === 'string' ? k : k.value] = extractValue(v);
    }
    return obj;
  }
  return r.value ?? r;
}

// ─── Tool Definitions ───────────────────────────────────────────────

const TOOLS = [
  {
    name: 'zen_list_pages',
    description: 'List all open pages/tabs in Zen browser with URLs and titles',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zen_select_page',
    description: 'Select a page/tab by index (from zen_list_pages) as the active target',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Page index' } },
      required: ['index'],
    },
  },
  {
    name: 'zen_new_tab',
    description: 'Open a new tab, optionally navigating to a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open (default: about:blank)' } },
    },
  },
  {
    name: 'zen_navigate',
    description: 'Navigate the active page to a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
      required: ['url'],
    },
  },
  {
    name: 'zen_snapshot',
    description: 'Get a structured snapshot of visible page elements with CSS selectors. Filter: "all", "interactive", or "form".',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'interactive', 'form'], description: 'Element filter (default: all)' },
        selector: { type: 'string', description: 'CSS selector to scope snapshot' },
      },
    },
  },
  {
    name: 'zen_screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zen_click',
    description: 'Click an element by CSS selector',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'zen_fill',
    description: 'Fill a text input or textarea with a value. Clears existing content first. Dispatches input/change events for framework compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of input/textarea' },
        value: { type: 'string', description: 'Value to fill' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'zen_select_option',
    description: 'Select an option in a <select> dropdown by value or text',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of select element' },
        value: { type: 'string', description: 'Option value or visible text' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'zen_check',
    description: 'Check/uncheck a checkbox or select a radio button',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        checked: { type: 'boolean', description: 'true=check, false=uncheck (default: true)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'zen_evaluate',
    description: 'Execute JavaScript in the page and return the result',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'JavaScript to evaluate' } },
      required: ['script'],
    },
  },
  {
    name: 'zen_get_form_fields',
    description: 'List all form fields on the page with names, types, labels, current values, and CSS selectors',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zen_fill_form',
    description: 'Fill multiple form fields at once. Each field specifies selector, value, and action (fill/select/check/uncheck/click).',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
              action: { type: 'string', enum: ['fill', 'select', 'check', 'uncheck', 'click'] },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'zen_scroll',
    description: 'Scroll the page or scroll an element into view',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount: { type: 'number', description: 'Pixels (default: 500)' },
        selector: { type: 'string', description: 'Element to scroll into view' },
      },
    },
  },
  {
    name: 'zen_wait',
    description: 'Wait for a specified number of milliseconds',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number', description: 'Milliseconds to wait (default: 1000)' } },
    },
  },
];

// ─── Tool Handlers ──────────────────────────────────────────────────

async function handleTool(name, args) {
  await bidi.ensureConnected();

  switch (name) {

    case 'zen_list_pages': {
      const contexts = await bidi.getContexts();
      const pages = [];
      for (let i = 0; i < contexts.length; i++) {
        const ctx = contexts[i];
        pages.push({
          index: i,
          contextId: ctx.context,
          url: ctx.url || '',
          active: ctx.context === bidi.currentContext,
          children: ctx.children?.length || 0,
        });
      }
      return text(JSON.stringify(pages, null, 2));
    }

    case 'zen_select_page': {
      const contexts = await bidi.getContexts();
      if (args.index < 0 || args.index >= contexts.length) {
        return text(`Invalid index ${args.index}. ${contexts.length} pages available.`);
      }
      bidi.currentContext = contexts[args.index].context;
      return text(`Selected page ${args.index}: ${contexts[args.index].url}`);
    }

    case 'zen_new_tab': {
      const ctx = await bidi.createTab(args?.url || 'about:blank');
      return text(`New tab created: ${ctx}` + (args?.url ? ` at ${args.url}` : ''));
    }

    case 'zen_navigate': {
      const result = await bidi.navigate(args.url);
      return text(`Navigated to ${args.url} (navigation: ${result.navigation})`);
    }

    case 'zen_snapshot': {
      const filter = args?.filter || 'all';
      const sel = args?.selector || null;
      const result = await bidi.callFunction(`
        function(filter, sel) {
          const scope = sel ? document.querySelector(sel) : document;
          if (!scope) return { error: 'Selector not found: ' + sel };

          const selectorMap = {
            all: 'input, textarea, select, button, a, [role="button"], [role="link"], [role="checkbox"], [role="radio"], h1, h2, h3, h4, h5, h6, p, label, li',
            interactive: 'input, textarea, select, button, a, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [contenteditable]',
            form: 'input, textarea, select',
          };

          const elements = scope.querySelectorAll(selectorMap[filter] || selectorMap.all);
          const items = [];

          elements.forEach((el) => {
            const tag = el.tagName.toLowerCase();
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            if (getComputedStyle(el).display === 'none') return;

            let selector = tag;
            if (el.id) selector = '#' + el.id;
            else if (el.name) selector = tag + '[name="' + el.name + '"]';
            else if (el.getAttribute('aria-label')) selector = tag + '[aria-label="' + el.getAttribute('aria-label') + '"]';

            const info = { tag, selector };
            if (el.type) info.type = el.type;
            if (el.name) info.name = el.name;
            if (el.id) info.id = el.id;
            if (el.value !== undefined && el.value !== '') info.value = String(el.value).substring(0, 200);
            if (el.placeholder) info.placeholder = el.placeholder;
            if (el.checked !== undefined) info.checked = el.checked;
            if (el.href) info.href = el.href;
            const role = el.getAttribute('role');
            if (role) info.role = role;
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) info.ariaLabel = ariaLabel;

            const label = el.closest('label')?.textContent?.trim()?.substring(0, 100)
              || (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent?.trim()?.substring(0, 100))
              || '';
            if (label) info.label = label;

            if (!['input', 'textarea', 'select'].includes(tag)) {
              const txt = el.textContent?.trim()?.substring(0, 120);
              if (txt) info.text = txt;
            }

            items.push(info);
          });

          return { count: items.length, elements: items };
        }
      `, [
        { type: 'string', value: filter },
        sel ? { type: 'string', value: sel } : { type: 'null' },
      ]);

      return text(JSON.stringify(extractValue(result), null, 2));
    }

    case 'zen_screenshot': {
      const result = await bidi.screenshot();
      if (result.data) {
        return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
      }
      return text('Screenshot captured (no data returned)');
    }

    case 'zen_click': {
      const result = await bidi.callFunction(`
        function(sel) {
          const el = document.querySelector(sel);
          if (!el) return { error: 'Element not found: ' + sel };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { clicked: sel };
        }
      `, [{ type: 'string', value: args.selector }]);
      return text(JSON.stringify(extractValue(result)));
    }

    case 'zen_fill': {
      const result = await bidi.callFunction(`
        function(sel, val) {
          const el = document.querySelector(sel);
          if (!el) return { error: 'Not found: ' + sel };
          el.focus();
          el.scrollIntoView({ block: 'center' });

          const proto = el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val);
          else el.value = val;

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          return { filled: sel, value: el.value.substring(0, 100) };
        }
      `, [
        { type: 'string', value: args.selector },
        { type: 'string', value: args.value },
      ]);
      return text(JSON.stringify(extractValue(result)));
    }

    case 'zen_select_option': {
      const result = await bidi.callFunction(`
        function(sel, val) {
          const select = document.querySelector(sel);
          if (!select) return { error: 'Not found: ' + sel };
          const option = Array.from(select.options).find(
            o => o.value === val || o.textContent.trim() === val
          );
          if (!option) return { error: 'Option not found: ' + val };
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: option.value, text: option.textContent.trim() };
        }
      `, [
        { type: 'string', value: args.selector },
        { type: 'string', value: args.value },
      ]);
      return text(JSON.stringify(extractValue(result)));
    }

    case 'zen_check': {
      const shouldCheck = args.checked !== false;
      const result = await bidi.callFunction(`
        function(sel, check) {
          const el = document.querySelector(sel);
          if (!el) return { error: 'Not found: ' + sel };
          el.scrollIntoView({ block: 'center' });
          if (el.checked !== check) el.click();
          return { selector: sel, checked: el.checked };
        }
      `, [
        { type: 'string', value: args.selector },
        { type: 'boolean', value: shouldCheck },
      ]);
      return text(JSON.stringify(extractValue(result)));
    }

    case 'zen_evaluate': {
      let script = args.script;
      // Wrap multi-statement scripts
      if (script.includes(';') && !script.startsWith('(')) {
        script = `(() => { ${script} })()`;
      }
      const result = await bidi.evaluate(script);
      return text(JSON.stringify(extractValue(result), null, 2));
    }

    case 'zen_get_form_fields': {
      const result = await bidi.callFunction(`
        function() {
          return Array.from(document.querySelectorAll('input, textarea, select')).map((el, i) => {
            const tag = el.tagName.toLowerCase();
            const rect = el.getBoundingClientRect();
            let selector = tag;
            if (el.id) selector = '#' + el.id;
            else if (el.name) selector = tag + '[name="' + el.name + '"]';

            const label = el.closest('label')?.textContent?.trim()?.substring(0, 100)
              || (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent?.trim()?.substring(0, 100))
              || '';

            let options;
            if (tag === 'select') {
              options = Array.from(el.options).map(o => ({
                value: o.value, text: o.textContent.trim(), selected: o.selected,
              }));
            }

            return {
              index: i, tag, type: el.type || '', name: el.name || '',
              id: el.id || '', selector, value: (el.value || '').substring(0, 200),
              placeholder: el.placeholder || '', label,
              checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
              required: el.required || false, disabled: el.disabled || false,
              visible: rect.width > 0 && rect.height > 0, options,
            };
          });
        }
      `);
      return text(JSON.stringify(extractValue(result), null, 2));
    }

    case 'zen_fill_form': {
      const results = [];
      for (const field of args.fields) {
        const action = field.action || 'fill';
        try {
          let fn;
          let fnArgs;

          if (action === 'fill') {
            fn = `function(sel, val) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              el.focus();
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }`;
            fnArgs = [{ type: 'string', value: field.selector }, { type: 'string', value: field.value }];
          } else if (action === 'select') {
            fn = `function(sel, val) {
              const s = document.querySelector(sel);
              if (!s) return { error: 'Not found: ' + sel };
              const opt = Array.from(s.options).find(o => o.value === val || o.textContent.trim() === val);
              if (!opt) return { error: 'Option not found: ' + val };
              s.value = opt.value;
              s.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }`;
            fnArgs = [{ type: 'string', value: field.selector }, { type: 'string', value: field.value }];
          } else if (action === 'check') {
            fn = `function(sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              if (!el.checked) el.click();
              return { ok: true, checked: el.checked };
            }`;
            fnArgs = [{ type: 'string', value: field.selector }];
          } else if (action === 'uncheck') {
            fn = `function(sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              if (el.checked) el.click();
              return { ok: true, checked: el.checked };
            }`;
            fnArgs = [{ type: 'string', value: field.selector }];
          } else if (action === 'click') {
            fn = `function(sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              el.click();
              return { ok: true };
            }`;
            fnArgs = [{ type: 'string', value: field.selector }];
          }

          const result = await bidi.callFunction(fn, fnArgs);
          const val = extractValue(result);
          results.push({ selector: field.selector, action, ...(val?.error ? { status: 'error', error: val.error } : { status: 'ok' }) });
        } catch (e) {
          results.push({ selector: field.selector, action, status: 'error', error: e.message });
        }
      }
      return text(JSON.stringify(results, null, 2));
    }

    case 'zen_scroll': {
      if (args?.selector) {
        await bidi.callFunction(`
          function(sel) { document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        `, [{ type: 'string', value: args.selector }]);
        return text(`Scrolled ${args.selector} into view`);
      }
      const dir = args?.direction || 'down';
      const amt = args?.amount || 500;
      await bidi.callFunction(`
        function(dir, amt) {
          if (dir === 'down') window.scrollBy(0, amt);
          else if (dir === 'up') window.scrollBy(0, -amt);
          else if (dir === 'top') window.scrollTo(0, 0);
          else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        }
      `, [{ type: 'string', value: dir }, { type: 'number', value: amt }]);
      return text(`Scrolled ${dir} ${amt}px`);
    }

    case 'zen_wait': {
      const ms = args?.ms || 1000;
      await new Promise(r => setTimeout(r, ms));
      return text(`Waited ${ms}ms`);
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

// ─── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: 'zen-browser', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await handleTool(name, args || {});
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}\n\nMake sure Zen is running with:\n  /Applications/Zen.app/Contents/MacOS/zen --remote-debugging-port ${PORT}`,
      }],
      isError: true,
    };
  }
});

process.on('SIGINT', async () => { await bidi.disconnect(); process.exit(0); });
process.on('SIGTERM', async () => { await bidi.disconnect(); process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
log(`Server started, connecting to Zen on ws://127.0.0.1:${PORT}/session`);
