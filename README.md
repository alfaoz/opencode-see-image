# opencode-see-image

Give non-vision opencode models the ability to **see images and screenshots** by routing them to a vision-capable model.

When a user attaches a screenshot to a text-only model, opencode rejects it with an error. This plugin intercepts that flow by registering a `see_image` tool that sends the image to a vision model and returns a textual description the primary model can reason about.

## Install

**Option A, one command (recommended):**
```bash
opencode plugin opencode-see-image --global
```
This installs the package and adds it to your config. Then restart opencode.

**Option B, edit config manually:**

Add the plugin to your opencode config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-see-image"]
}
```
Then restart opencode.

## Install via your agent

Ask your agent:
```
install the opencode-see-image plugin
```
It'll run `opencode plugin opencode-see-image --global` and tell you to restart.

## Prerequisites

You need a connected vision-capable provider. The plugin auto-detects whichever you have connected, **either of these works**:

### Free (OpenCode Zen)
1. Run `/connect` in opencode
2. Select **opencode** (OpenCode Zen)
3. Paste your API key from [opencode.ai/auth](https://opencode.ai/auth)

The plugin falls back to **big-pickle** (~12000ms). No subscription needed.

### Paid, w/ OpenCode Go
1. Run `/connect` in opencode
2. Select **opencode-go**
3. Paste your API key from [opencode.ai/auth](https://opencode.ai/auth)

The plugin prefers **minimax-m3** via opencode-go (~3000ms) when available.

### Paid, w/ another provider

Set the `SEE_IMAGE_*` env vars to point at any Anthropic-Messages-compatible endpoint. See [Configuration](#configuration) below.

**Resolution order:** explicit `SEE_IMAGE_API_KEY` env → configured `SEE_IMAGE_PROVIDER` → `opencode-go` (MiniMax M3) → `opencode` (big-pickle, free).

## How it works

```
user attaches screenshot
        │
        ▼
opencode rejects it: 'this model does not support image input'
        │  (the model only sees the filename, no pixels)
        ▼
plugin's system-prompt instructions tell the model to call see_image
        │
        ▼
see_image tool:
  1. locates the file (macOS screenshot temp dirs, ~/Desktop, ~/Downloads, cwd)
  2. base64-encodes it
  3. routes it to the vision model via opencode's SDK (or direct HTTP if SEE_IMAGE_API_KEY is set)
  4. returns the textual description
        │
        ▼
primary model answers using the description
```

## The `see_image` tool

The plugin registers a `see_image` tool with two arguments:

| Arg | Type | Required | Description |
|---|---|---|---|
| `filePath` | string | yes | Path to the image. Absolute path, or a bare filename like `"Screenshot 2026-06-18 at 17.32.24.png"` to auto-locate. |
| `question` | string | no | A specific question about the image. Defaults to a general detailed description. Use this to focus on a particular detail (e.g. `"What error is shown in the terminal?"`). |

Your model calls this tool automatically when you attach a screenshot, you don't need to do anything special. The `question` arg is optional; the model uses it when you ask something specific about the image.

## Configuration

All settings are env-var overrides. The plugin uses opencode's SDK client by default (handles auth automatically). Set `SEE_IMAGE_API_KEY` to bypass the SDK and call an HTTP endpoint directly.

| Env var | Default | Description |
|---|---|---|
| `SEE_IMAGE_MODEL` | `minimax-m3` | Vision model ID |
| `SEE_IMAGE_PROVIDER` | `opencode-go` | Provider ID for SDK routing |
| `SEE_IMAGE_API_KEY` | _(uses SDK)_ | Bypass SDK, call HTTP endpoint directly |
| `SEE_IMAGE_ENDPOINT` | `https://opencode.ai/zen/go/v1/messages` | HTTP endpoint (only used if `SEE_IMAGE_API_KEY` is set) |
| `SEE_IMAGE_API_VERSION` | `2023-06-01` | `anthropic-version` header (HTTP mode only) |
| `SEE_IMAGE_USER_AGENT` | _(Chrome UA)_ | User-Agent header (HTTP mode only) |

### Using a different vision model

Any Anthropic-Messages-compatible endpoint works. For example, to use a direct MiniMax key:

```bash
export SEE_IMAGE_ENDPOINT="https://api.minimax.io/v1/messages"
export SEE_IMAGE_MODEL="minimax-m3"
export SEE_IMAGE_API_KEY="your-minimax-key"
```

To use a different opencode-go model (e.g. Kimi K2.7):

```bash
export SEE_IMAGE_MODEL="kimi-k2.7-code"
```

### Verified vision-capable models

**Free (OpenCode Zen):**

| Model | Speed | Notes |
|---|---|---|
| `big-pickle` | ~12000ms | Free. Accurate. Default fallback when only Zen is connected. |

**Paid (OpenCode Go):**

| Model | Speed | Notes |
|---|---|---|
| `minimax-m3` | ~3000ms | Default. Fast, clean text output. |
| `kimi-k2.7-code` | ~7000ms | Clean output, accurate. |
| `kimi-k2.6` | ~20000ms | Accurate but slow. |
| `qwen3.7-plus` | ~20000ms | Emits thinking blocks (handled). |

## Updating

**Auto-update (built in):** the plugin checks npm for a newer version on every opencode startup. If one exists, it updates itself via `opencode plugin --force` (uses opencode's bundled bun, no global bun needed) and shows a toast: *"opencode-see-image updated to X.Y.Z, restart opencode to apply"*. You just need to restart opencode to load the new version. Nothing to configure.

**Manual update** (if you want to force it now):
```bash
opencode plugin opencode-see-image --force --global
```
Then restart opencode. (No bun required, this uses opencode's own bun.)

**Pin a version** in your config to opt out of auto-updates:
```jsonc
"plugin": ["opencode-see-image@0.4.2"]
```

## Limitations

- **Clipboard pastes don't work** — when you paste an image from clipboard (Cmd+V), opencode processes it in-memory but discards it before writing to disk if the model doesn't support image input. The plugin can't access it. **Drag screenshots instead**, or save the clipboard image to a file first.
- **macOS only** — file search locations target macOS screenshot temp dirs. Linux/Windows users need to pass absolute paths.

## File search locations

When opencode rejects an image attachment, the model only receives a bare filename. `see_image` searches these locations in order:

1. `$TMPDIR/TemporaryItems/NSIRD_screencaptureui_*/` (where macOS stashes dragged screenshots)
2. `$TMPDIR/TemporaryItems/`
3. `~/Desktop` (default screenshot save location)
4. `~/Downloads`
5. Current working directory

Pass an absolute `filePath` to skip the search.

## License

MIT
