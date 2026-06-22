# opencode-see-image

give non-vision opencode models the ability to see images and screenshots by routing them to a vision-capable model.

when a user attaches a screenshot to a text-only model, opencode rejects it with an error. This plugin intercepts that flow by registering a `see_image` tool that sends the image to a vision model and returns a textual description the primary model can reason about.

## install

**one command (recommended):**
```bash
opencode plugin opencode-see-image --global
```
This installs the package and adds it to your config. Then restart opencode.

**edit config manually:**

Add the plugin to your opencode config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-see-image"]
}
```
Then restart opencode.

## install via your agent (for some reason?)

ask your agent:
```
install the opencode-see-image plugin
```
it'll run `opencode plugin opencode-see-image --global` and tell you to restart. 

## prerequisites

you need a connected vision-capable provider. The plugin auto-detects whichever you have connected, **either of these work**:

### free (OpenCode Zen)
1. run `/connect` in opencode
2. select **opencode** (OpenCode Zen)
3. paste your API key from [opencode.ai/auth](https://opencode.ai/auth)

the plugin uses **mimo-v2.5-free** automatically — if you don't have an OpenCode Go sub, it skips the paid model entirely (no errors) and routes to the free model.

### paid, w/ OpenCode Go
1. run `/connect` in opencode
2. select **opencode-go**
3. paste your API key from [opencode.ai/auth](https://opencode.ai/auth)

the plugin prefers **minimax-m3** via opencode-go when available.

### paid, w/ another provider

set the `SEE_IMAGE_*` env vars to point at any Anthropic-Messages-compatible endpoint. see [Configuration](#configuration) below.

**the resolve order:** explicit `SEE_IMAGE_API_KEY` env → configured `SEE_IMAGE_PROVIDER` → `opencode-go` (MiniMax M3) *if you have a Go sub connected* → `opencode` (mimo-v2.5-free). If no Go sub is connected, `opencode-go` is skipped so free users never hit a "model not found" error.

## how the _eye surgery_ works

```
user attaches screenshot
        |
        v
opencode rejects it: 'this model does not support image input'
        |      (the model only sees the filename)
        v
plugin's system-prompt instructions tell the model to call see_image
        |
        v
see_image tool:
  1. queries opencode's SQLite DB for the image
  2. falls back to filesystem search if not in DB
  3. sends the image to the vision model via opencode's SDK
  4. returns the textual description
        |
        v
primary model answers using the description
```

## the `see_image` tool

the plugin registers a `see_image` tool with two arguments:

| arg | type | required? | description |
|---|---|---|---|
| `filePath` | string | y | path to the image. Absolute path, or a bare filename like `"Screenshot 2026-06-18 at 17.32.24.png"` to auto-locate. |
| `question` | string | n | a specific question about the image. Defaults to a general detailed description. Use this to focus on a particular detail (e.g. `"What error is shown in the terminal?"`). |

your model calls this tool automatically when you attach a screenshot, you don't need to do anything special. The `question` arg is optional; the model uses it when you ask something specific about the image.

## configuration

all settings are env-var overrides. The plugin uses opencode's SDK client by default (handles auth automatically). Set `SEE_IMAGE_API_KEY` to bypass the SDK and call an HTTP endpoint directly.

| env var | default | description |
|---|---|---|
| `SEE_IMAGE_MODEL` | `minimax-m3` | Vision model ID |
| `SEE_IMAGE_PROVIDER` | `opencode-go` | Provider ID for SDK routing |
| `SEE_IMAGE_API_KEY` | _(uses SDK)_ | Bypass SDK, call HTTP endpoint directly |
| `SEE_IMAGE_ENDPOINT` | `https://opencode.ai/zen/go/v1/messages` | HTTP endpoint (only used if `SEE_IMAGE_API_KEY` is set) |
| `SEE_IMAGE_API_VERSION` | `2023-06-01` | `anthropic-version` header (HTTP mode only) |
| `SEE_IMAGE_USER_AGENT` | _(Chrome UA)_ | User-Agent header (HTTP mode only) |
| `SEE_IMAGE_TIMEOUT` | `30000` | Per-candidate timeout in ms. Prevents hanging on slow models. |

### using a different vision model

any Anthropic-Messages-compatible endpoint works. for example, to use a direct MiniMax key:

```bash
export SEE_IMAGE_ENDPOINT="https://api.minimax.io/v1/messages"
export SEE_IMAGE_MODEL="minimax-m3"
export SEE_IMAGE_API_KEY="your-minimax-key"
```

to use a different opencode-go model (e.g. Kimi K2.7):

```bash
export SEE_IMAGE_MODEL="kimi-k2.7-code"
```

### verified vision-capable models

**Free (OpenCode Zen):**

| model | Notes |
|---|---|
| `mimo-v2.5-free` |  free. may be a bit slow. default fallback when only Zen is connected (routed via CLI). |
| `big-pickle` | for some reason, big pickle works as an image capable model when called through the sdk w/ an active opencode go sub. |

**paid (OpenCode Go):**

| model | speed | notes |
|---|---|---|
| `minimax-m3` | ~3000ms | default. fast, clean, and accurate. |
| `kimi-k2.7-code` | ~7000ms | clean and accurate. |
| `kimi-k2.6` | ~12000ms | accurate but slow. |
| `qwen3.7-plus` | ~15000ms | slow, spends a bit more tokens because of thinking. |

## updating

**auto-update (built in):** uses the opencode-plugin-update-kit and shows a toast: *"opencode-see-image updated to X.Y.Z, restart opencode to apply"*. You just need to restart opencode to load the new version.

**manual update**:
```bash
opencode plugin opencode-see-image --force --global
```
then restart opencode.

**pin a version** in your config to opt out of auto-updates:
```jsonc
"plugin": ["opencode-see-image@0.4.2"]
```

## platform support

works on **macOS, Windows, and Linux**. The DB lookup is cross-platform; the filesystem fallback now searches per-platform screenshot locations (see below). The plugin probes several opencode data-dir locations so the DB and auth keys are found wherever opencode stored them.

## file search locations

when opencode rejects an image attachment, the model only receives a bare filename. `see_image` first checks the opencode DB (cross-platform), then falls back to searching these filesystem locations, in order:

**macOS**
1. `$TMPDIR/TemporaryItems/NSIRD_screencaptureui_*/` (where macOS stashes dragged screenshots)
2. `$TMPDIR/TemporaryItems/`
3. `~/Desktop`, `~/Downloads`, current working directory

**Windows**
1. `%TEMP%` / `%TMP%` (dragged/temp images)
2. `%USERPROFILE%\Pictures\Screenshots` and the OneDrive-redirected `%USERPROFILE%\OneDrive\Pictures\Screenshots` (Win+PrtScn / Snipping Tool)
3. `%USERPROFILE%\Pictures`
4. `~\Desktop`, `~\Downloads`, current working directory

**Linux**
1. `$TMPDIR` / `/tmp`
2. `~/Pictures/Screenshots`, `~/Pictures`
3. `~/Desktop`, `~/Downloads`, current working directory

pass an absolute `filePath` to skip the search.

## License

MIT
