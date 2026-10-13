# Codespaces setup

## Clipboard copy/paste

### Root cause

VS Code Web (including Codespaces) runs in a sandboxed cross-origin
iframe. The browser's Clipboard API (`navigator.clipboard.readText()`)
is blocked by a Permissions Policy. The iframe's sandbox attribute is
set by GitHub and does not include `clipboard-read`. No repo file can
change this.

### Why Ctrl+V fails

When you press Ctrl+V, VS Code intercepts it and calls the browser's
Clipboard API. The browser blocks the call because the iframe lacks
permission. You see: "Unable to read from the browser's clipboard."

### Why Shift+Insert works

Shift+Insert triggers the browser's native paste mechanism, which
does NOT use the Clipboard API. It bypasses the permissions policy
entirely.

### Workarounds (ranked)

1. Shift+Insert (Windows/Linux) -- highest reliability
2. Shift+Cmd+V (macOS) -- native paste equivalent
3. Ctrl+Shift+V -- VS Code's terminal paste command
4. Right-click -- pastes if no text is selected
5. Open in new browser window -- breaks iframe nesting, lets the
   browser prompt for clipboard permission
6. VS Code Desktop -- no browser, no iframe, no issue

### Browser configuration

**Chrome/Edge:**
- Open chrome://settings/content/clipboard
- Add [*.]github.dev and [*.]app.github.dev
- Reload the Codespace tab
- Note: this helps but does not fully bypass the iframe restriction

**Firefox:**
- Open about:config
- Set dom.events.testing.asyncClipboard to true
- Disable Enhanced Tracking Protection for github.dev (shield icon)
- Reload the Codespace tab

**Safari:**
- Clipboard API in cross-origin iframes is effectively broken.
- Use Chrome or Firefox instead.

### Terminal shortcuts reference

| Action | Shortcut |
|---|---|
| Paste (reliable) | Shift+Insert |
| Paste (macOS) | Shift+Cmd+V |
| Copy selection | Ctrl+Shift+C |
| Auto-copy on select | enabled via settings.json |
| Right-click paste | enabled via settings.json |

### Terminal OSC 52

Programmatic clipboard population via OSC 52 escape sequences does
not work in Codespaces terminals. Tools that rely on it (tmux, vim)
will not be able to write to the system clipboard.
