// Shared, runtime-agnostic pieces for opencode-see-image.
//
// Both the v1 (legacy `{ id, server }`) and v2 (`{ id, setup }`) adapters in
// v1.ts / v2.ts import from here: plugin option resolution, the
// Anthropic-Messages HTTP call, the system-prompt text, the heartbeat, and the
// provider-key lookup. Keeping it separate means there is exactly one copy of
// the vision-route config and the system prompt, so the two adapters cannot
// drift.

import path from "path"
import fs from "fs"
import { EXT_MEDIA, opencodeDataDirs } from "./lib.ts"

// Plugin options (config tuple form: ["opencode-see-image", { ... }]).
// Each field falls back to the corresponding SEE_IMAGE_* env var, then to a
// built-in default, so existing env-based setups keep working unchanged.
export type SeeImageOptions = {
  provider?: string
  model?: string
  endpoint?: string
  apiKey?: string
  timeout?: number
  apiVersion?: string
  userAgent?: string
}

export type SeeImageConfig = {
  provider: string
  model: string
  // provider+model were user-set (options or env), not defaulted
  routeConfigured: boolean
  endpoint: string
  apiKey?: string
  timeout: number
  apiVersion: string
  userAgent: string
}

export type VisionResult = { text: string; model: string; provider: string }

const DEFAULT_ENDPOINT = "https://opencode.ai/zen/go/v1/messages"
const DEFAULT_MODEL = "minimax-m3"
const DEFAULT_PROVIDER = "opencode-go"
const DEFAULT_TIMEOUT = 30000
const DEFAULT_API_VERSION = "2023-06-01"
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

export const PKG_NAME = "opencode-see-image"

export function resolveConfig(options: SeeImageOptions = {}): SeeImageConfig {
  // config gives numbers, env gives strings; reject garbage either way
  const ms = (v: unknown): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const provider = options.provider || process.env.SEE_IMAGE_PROVIDER
  const model = options.model || process.env.SEE_IMAGE_MODEL
  return {
    provider: provider || DEFAULT_PROVIDER,
    model: model || DEFAULT_MODEL,
    routeConfigured: Boolean(provider && model),
    endpoint: options.endpoint || process.env.SEE_IMAGE_ENDPOINT || DEFAULT_ENDPOINT,
    apiKey: options.apiKey || process.env.SEE_IMAGE_API_KEY,
    timeout: ms(options.timeout) ?? ms(process.env.SEE_IMAGE_TIMEOUT) ?? DEFAULT_TIMEOUT,
    apiVersion: options.apiVersion || process.env.SEE_IMAGE_API_VERSION || DEFAULT_API_VERSION,
    userAgent: options.userAgent || process.env.SEE_IMAGE_USER_AGENT || DEFAULT_USER_AGENT,
  }
}

// The vision helper must run tool-less (issue #6): it processes
// attacker-influenceable content (the image + question), so it must never
// hold bash/edit/webfetch/etc. In session.prompt, each `tools` entry becomes
// a session permission rule evaluated with wildcard matching, so "*": false
// strips every tool from the request and denies any stragglers — while the
// old `tools: {}` meant "no overrides" and silently left the FULL default
// toolset enabled. The named entries are a second, independent layer: the
// per-message tools record is also consulted with exact-name matching when
// the request is assembled.
export const SDK_NO_TOOLS: Record<string, boolean> = {
  "*": false,
  bash: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  read: false,
  glob: false,
  grep: false,
  list: false,
  webfetch: false,
  websearch: false,
  task: false,
  skill: false,
  todowrite: false,
  todoread: false,
}

// Same lockdown for the CLI fallback, expressed as config permissions.
// OPENCODE_PERMISSION merges over the user's config permission block: "*"
// deny catches every tool (rules are wildcard-matched, last match wins), and
// the named keys overwrite any explicit per-tool "allow" a user may have set
// globally. Keys are permission names, not tool ids — write/patch fold into
// "edit". Supported by opencode across the whole 1.x line.
export const CLI_NO_TOOLS_PERMISSION = JSON.stringify({
  "*": "deny",
  bash: "deny",
  edit: "deny",
  read: "deny",
  glob: "deny",
  grep: "deny",
  list: "deny",
  webfetch: "deny",
  websearch: "deny",
  task: "deny",
  skill: "deny",
  todowrite: "deny",
  external_directory: "deny",
  lsp: "deny",
  question: "deny",
})

// Animated heartbeat shown in the tool title while we wait, so the user can
// see the call is alive. Purely cosmetic — never touches the vision call.
const HEARTBEAT_FRAMES = ["░", "▒", "▓", "█", "▓", "▒", "░"]
export function heartbeatBar(tick: number, width = 12): string {
  let s = ""
  for (let i = 0; i < width; i++) {
    s += HEARTBEAT_FRAMES[(i + tick) % HEARTBEAT_FRAMES.length]
  }
  return s
}

// Read an API key straight out of opencode's auth store. Used to decide
// whether the paid opencode-go route is available before we try it (so free
// users never hit a fatal "model not found") and to fall back to the direct
// HTTP route when the SDK route yields nothing.
export function readProviderKey(providerID: string): string | null {
  try {
    for (const dir of opencodeDataDirs()) {
      const authPath = path.join(dir, "auth.json")
      if (!fs.existsSync(authPath)) continue
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"))
      const entry = auth[providerID]
      if (entry?.type === "api" && entry?.key) return entry.key
    }
    return null
  } catch {
    return null
  }
}

// Direct Anthropic-Messages call. Used when an explicit apiKey is configured,
// and as a last-resort fallback when the SDK routes yield nothing.
export async function seeImageViaHTTP(
  b64: string,
  mediaType: string,
  prompt: string,
  cfg: SeeImageConfig,
  abort?: AbortSignal,
  keyOverride?: string,
): Promise<VisionResult> {
  const key = keyOverride || cfg.apiKey!
  const body = {
    model: cfg.model,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: b64 },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  }

  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": cfg.apiVersion,
      "content-type": "application/json",
      "user-agent": cfg.userAgent,
    },
    body: JSON.stringify(body),
    signal: abort,
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(
      `see_image: HTTP vision call to "${cfg.model}" failed: HTTP ${res.status}, ${errText.slice(0, 300)}`,
    )
  }

  const data: any = await res.json()
  const text = data?.content
    ?.map((c: any) => c.text)
    .filter((t: any) => typeof t === "string" && t.length > 0)
    .join("\n")
    .trim()

  if (!text) {
    throw new Error(
      `see_image: model "${cfg.model}" returned no text. Response: ${JSON.stringify(data).slice(0, 300)}`,
    )
  }

  return { text, model: cfg.model, provider: cfg.provider }
}

// Shared default question and the media-type → extension table re-exported so
// adapters can resolve the on-disk extension for the CLI fallback.
export { EXT_MEDIA }

export const SYSTEM_INSTRUCTIONS = `# See Image (vision bridge), opencode-see-image plugin

You have a \`see_image\` tool. When the user attaches an image, this model cannot view it directly — you may receive an error string containing the **filename**, a placeholder like \`[Image #1]\`, or nothing at all. You MUST call \`see_image\` to actually view it — do NOT just tell the user you can't see images.

## When you MUST call \`see_image\`

Call \`see_image\` immediately in ALL these cases — do not inform the user, do not ask for confirmation:

1. You receive an error containing \`Cannot read "Screenshot ..."\` or \`Cannot read "...png"\` or \`Cannot read "...jpg"\`
2. The error message says \`this model does not support image input\`
3. The error starts with \`ERROR:\` and mentions an image file
4. The user's message contains an image attachment or a placeholder like \`[Image #1]\`
5. The user references an image/screenshot ("see this", "look at this", ".png", ".jpg")
6. The user pastes an image path

## How to use it

1. If you know the filename (from an error message or the user), pass it as \`filePath\` — the bare filename is fine, e.g. \`Screenshot 2026-06-19 at 02.18.53.png\`
2. If you do NOT know the filename (e.g. a pasted/attached image with no name), call \`see_image\` with NO \`filePath\` — it automatically uses the most recent image attached to this conversation
3. Optionally pass a \`question\` if the user asked something specific
4. Answer using the returned description as if you saw the image. Be natural.

## Important

- NEVER just repeat the error to the user. Call the tool.
- If \`see_image\` fails, its error message lists the images attached to this session — retry with one of those exact filenames.
- Do NOT use \`see_image\` for text files (\`.ts\`, \`.md\`, \`.json\`, etc.) — use \`read\` instead.
- Never guess image contents. If you haven't called \`see_image\`, you haven't seen the image.`

export const DEFAULT_QUESTION =
  "Describe this image in detail. If it is a screenshot, describe the UI, text content, and layout precisely. This description will be used by another model to answer the user, so be thorough and accurate."

export const TOOL_DESCRIPTION =
  'See an image/screenshot that the current model cannot view. Use when the user attaches an image and you get a "this model does not support image input" / "Cannot read" error, when the message contains an image placeholder like [Image #1], or when a screenshot/image is referenced ("see this", "can you see", .png/.jpg). Routes the image to a vision-capable model and returns a detailed textual description you can reason about as if you saw it. Pass filePath as an absolute path or bare filename, or omit it to use the most recently attached image in this conversation. Do NOT call this if you can already view images natively — you have already seen any attached image directly.'

export const FILEPATH_DESCRIPTION =
  'Path to the image. Absolute path, or a bare filename like "Screenshot 2026-06-18 at 17.32.24.png" to auto-locate. Omit entirely (or pass "latest") to use the most recent image attached to this conversation.'

export const QUESTION_DESCRIPTION = [
  "What to ask the vision model. Omit for a general detailed description.",
  "Tailor it to the situation for much better results:",
  '- Reading/transcribing text or code: "Transcribe all text exactly, preserving layout, line breaks, and code indentation."',
  '- An error or stack trace screenshot: "Quote the exact error message and stack trace, then state the likely cause."',
  '- Reproducing a UI as code: "Describe the layout, components, text, colors, and spacing precisely enough to rebuild this UI in code."',
  '- A technical diagram/architecture: "Explain this diagram: list each component and the relationships and data/flow direction between them."',
  '- A UI/screen where positions matter (alignment bugs, "where is X", overlapping or misplaced elements): "Describe the layout and include a labeled ASCII diagram of the spatial arrangement of elements."',
  '- A chart/graph/dashboard: "Read this visualization: axes, series, key values, and the main takeaway."',
  '- Comparing against an expected design: "Describe this UI in detail so it can be diffed against an expected layout (note any visible defects or misalignment)."',
  'Otherwise pass the user\'s own specific question verbatim. If the question concerns a UI/screen and spatial arrangement matters to answering it, append: "Also include a labeled ASCII diagram of the layout."',
].join("\n")
