# opencode-see-image

Give non-vision opencode models the ability to **see images and screenshots** by routing them to a vision-capable model.

When a user attaches a screenshot to a text-only model (e.g. GLM-5.2, DeepSeek, Kimi), opencode rejects it with an error. This plugin intercepts that flow: it registers a `see_image` tool that sends the image to a vision model (MiniMax M3 by default) and returns a textual description the primary model can reason about.

## Install

Add the plugin to your opencode config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-see-image"]
}
```

Then **restart opencode**.

That's it — the plugin self-contains both the tool and the triggering instructions (injected into the system prompt). No separate skill file needed.

## Prerequisites

You need a connected vision-capable provider. The plugin auto-detects whichever you have connected — **either of these works**:

### Option A — Free (OpenCode Zen)
1. Run `/connect` in opencode
2. Select **opencode** (OpenCode Zen)
3. Paste your API key from [opencode.ai/auth](https://opencode.ai/auth)

The plugin falls back to **big-pickle** (free, vision-capable, ~20s). No subscription needed.

### Option B — Paid, fast (OpenCode Go)
1. Run `/connect` in opencode
2. Select **opencode-go**
3. Paste your API key from [opencode.ai/auth](https://opencode.ai/auth)

The plugin prefers **minimax-m3** via opencode-go (~3s) when available.

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
  3. sends it to the vision model via the Anthropic Messages API
  4. returns the textual description
        │
        ▼
primary model answers using the description
```

## Configuration

All settings are env-var overrides. Defaults work out-of-the-box for opencode-go + MiniMax M3.

| Env var | Default | Description |
|---|---|---|
| `SEE_IMAGE_MODEL` | `minimax-m3` | Vision model ID to call |
| `SEE_IMAGE_PROVIDER` | `opencode-go` | Provider key in opencode's `auth.json` |
| `SEE_IMAGE_ENDPOINT` | `https://opencode.ai/zen/go/v1/messages` | Anthropic-Messages-compatible endpoint |
| `SEE_IMAGE_API_KEY` | _(reads auth.json)_ | Bypass auth.json with an explicit key |
| `SEE_IMAGE_API_VERSION` | `2023-06-01` | `anthropic-version` header value |
| `SEE_IMAGE_USER_AGENT` | _(Chrome UA)_ | Override the User-Agent header |

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
| `big-pickle` | ~20s | Free. Accurate. Default fallback when only Zen is connected. |

**Paid (OpenCode Go):**

| Model | Speed | Notes |
|---|---|---|
| `minimax-m3` | ~3s | Default. Fast, clean text output. |
| `kimi-k2.7-code` | ~7s | Clean output, accurate. |
| `kimi-k2.6` | ~20s | Accurate but slow. |
| `qwen3.7-plus` | ~20s | Emits thinking blocks (handled). |

## File search locations

When opencode rejects an image attachment, the model only receives a bare filename. `see_image` searches these locations in order:

1. `$TMPDIR/TemporaryItems/NSIRD_screencaptureui_*/` — where macOS stashes dragged screenshots
2. `$TMPDIR/TemporaryItems/`
3. `~/Desktop` — default screenshot save location
4. `~/Downloads`
5. Current working directory

Pass an absolute `filePath` to skip the search.

## Install via your agent (copy-paste this)

Paste this prompt to your opencode agent — it'll install the plugin for you:

```
Install the opencode-see-image plugin so I can send you screenshots. Do this:

1. Edit ~/.config/opencode/opencode.jsonc (create it if missing). Preserve any existing fields and the $schema. Add "opencode-see-image" to the "plugin" array. If "plugin" doesn't exist, add it as ["opencode-see-image"].
2. Check that a vision-capable provider is connected by looking for ~/.local/share/opencode/auth.json with either an "opencode-go" entry (paid, fast) OR an "opencode" entry (free). If neither is present, tell me to run /connect and select either opencode-go or opencode (key from opencode.ai/auth).
3. Tell me to quit and restart opencode for the plugin to load.

After I restart and attach a screenshot, you should call the see_image tool to view it.
```

## License

MIT
