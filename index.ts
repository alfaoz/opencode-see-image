import { tool } from "@opencode-ai/plugin"
import path from "path"
import os from "os"
import fs from "fs"
import type { Plugin } from "@opencode-ai/plugin"

// ─── Configuration (env-overridable) ────────────────────────────────────────
// Defaults target opencode-go's MiniMax M3. Users on other providers can
// override via environment variables without editing this file.

const ENDPOINT =
  process.env.SEE_IMAGE_ENDPOINT ||
  "https://opencode.ai/zen/go/v1/messages"
const MODEL = process.env.SEE_IMAGE_MODEL || "minimax-m3"
const PROVIDER_ID = process.env.SEE_IMAGE_PROVIDER || "opencode-go"
const API_VERSION = process.env.SEE_IMAGE_API_VERSION || "2023-06-01"
const USER_AGENT =
  process.env.SEE_IMAGE_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

const EXT_MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
}

// ─── Auth ───────────────────────────────────────────────────────────────────
function readApiKey(): string {
  // 1. Explicit env var wins.
  if (process.env.SEE_IMAGE_API_KEY) return process.env.SEE_IMAGE_API_KEY

  // 2. Read from opencode's auth store (~/.local/share/opencode/auth.json).
  const authPath = path.join(os.homedir(), ".local/share/opencode/auth.json")
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"))
    const entry = auth[PROVIDER_ID]
    if (entry && (entry.key || entry.access)) {
      return entry.key || entry.access
    }
  } catch {
    // fall through to error
  }

  throw new Error(
    `see_image: no API key. Either run /connect for "${PROVIDER_ID}" in opencode, ` +
      `or set SEE_IMAGE_API_KEY, or set SEE_IMAGE_PROVIDER to a connected provider ID. ` +
      `(Looked in ${authPath} for key "${PROVIDER_ID}".)`,
  )
}

// ─── File resolution ────────────────────────────────────────────────────────
// When opencode rejects an image attachment, the model only sees a bare
// filename (no path). This resolves bare filenames by searching the places
// macOS / opencode tend to stash screenshots.
function resolveFilePath(name: string, cwd: string): string {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name

  const resolved = path.resolve(cwd, name)
  if (fs.existsSync(resolved)) return resolved

  const tmpdir = process.env.TMPDIR || "/tmp"
  const searchDirs: string[] = []

  // macOS screenshot tool temp dirs (NSIRD_screencaptureui_<rand>) — this is
  // where dragged screenshots actually land, not ~/Desktop.
  const tempItems = path.join(tmpdir, "TemporaryItems")
  if (fs.existsSync(tempItems)) {
    try {
      for (const sub of fs.readdirSync(tempItems, { withFileTypes: true })) {
        if (sub.isDirectory() && sub.name.startsWith("NSIRD_screencaptureui")) {
          searchDirs.push(path.join(tempItems, sub.name))
        }
      }
    } catch {}
  }
  searchDirs.push(tempItems)
  searchDirs.push(path.join(os.homedir(), "Desktop"))
  searchDirs.push(path.join(os.homedir(), "Downloads"))
  searchDirs.push(cwd)

  for (const dir of searchDirs) {
    if (!dir) continue
    try {
      const full = path.join(dir, name)
      if (fs.existsSync(full)) return full
    } catch {}
  }

  // Shallow recursive search in the top-level search dirs.
  for (const dir of searchDirs) {
    if (!dir || !fs.existsSync(dir)) continue
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === name) return path.join(dir, name)
      }
    } catch {}
  }

  const searched = searchDirs.filter(Boolean).join(", ")
  throw new Error(
    `see_image: could not find "${name}". Searched: ${searched}. ` +
      `Pass an absolute filePath instead.`,
  )
}

// ─── Tool definition ────────────────────────────────────────────────────────
const seeImageTool = tool({
  description:
    'See an image/screenshot that the current model cannot view. Use when the user attaches an image and you get a "this model does not support image input" / "Cannot read" error, or when a screenshot/image is referenced ("see this", "can you see", .png/.jpg). Routes the image to a vision-capable model and returns a detailed textual description you can reason about as if you saw it. Pass filePath as an absolute path OR a bare filename (auto-located in macOS screenshot temp dirs, ~/Desktop, ~/Downloads, cwd).',
  args: {
    filePath: tool.schema
      .string()
      .describe(
        'Path to the image. Absolute path, or a bare filename like "Screenshot 2026-06-18 at 17.32.24.png" to auto-locate.',
      ),
    question: tool.schema
      .string()
      .optional()
      .describe(
        "Optional specific question about the image. Defaults to a general detailed description.",
      ),
  },
  async execute(args, context) {
    const fullPath = resolveFilePath(args.filePath, context.directory)
    const ext = path.extname(fullPath).slice(1).toLowerCase()
    const mediaType = EXT_MEDIA[ext] || "image/png"

    const buf = fs.readFileSync(fullPath)
    const b64 = Buffer.from(buf).toString("base64")

    const prompt =
      args.question && args.question.trim().length > 0
        ? args.question
        : "Describe this image in detail. If it is a screenshot, describe the UI, text content, and layout precisely. This description will be used by another model to answer the user, so be thorough and accurate."

    const body = {
      model: MODEL,
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

    const key = readApiKey()
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(
        `see_image: vision call to "${MODEL}" failed: HTTP ${res.status} — ${errText.slice(0, 300)}`,
      )
    }

    const data: any = await res.json()
    // Join all text blocks, skipping thinking/signature blocks (some models
    // like qwen/minimax-m2.7 emit reasoning before the answer).
    const text = data?.content
      ?.map((c: any) => c.text)
      .filter((t: any) => typeof t === "string" && t.length > 0)
      .join("\n")
      .trim()

    if (!text) {
      throw new Error(
        `see_image: model "${MODEL}" returned no text. Response: ${JSON.stringify(data).slice(0, 300)}`,
      )
    }

    context.metadata({
      title: `see_image: ${path.basename(fullPath)}`,
      metadata: { model: MODEL, provider: PROVIDER_ID, file: fullPath },
    })

    return text
  },
})

// ─── System prompt injection (the "skill") ──────────────────────────────────
// Injected via experimental.chat.system.transform so the triggering logic
// ships with the plugin — no separate SKILL.md install needed.
const SYSTEM_INSTRUCTIONS = `# See Image (vision bridge) — opencode-see-image plugin

You have access to a \`see_image\` tool. The current model may not support image input directly. When a user attaches a screenshot or image, opencode rejects it and you only receive an error string containing the **filename** — no path, no pixels. Use \`see_image\` to actually view it.

## When to use \`see_image\`

Use ONLY when one of these is true:
1. You receive an error like: \`Cannot read "Screenshot ....png" (this model does not support image input)\`
2. The user references an image/screenshot they expect you to see ("see this", "look at this", "can you see this", ".png"/".jpg")
3. The user pastes an image path they want you to inspect

Do NOT use \`see_image\` for reading text files — use the \`read\` tool for those.

## How to use it

1. **Extract the filename** from the error string (the quoted name), or use the path the user gave.
2. **Call \`see_image\`** with \`filePath\` set to the bare filename (it auto-locates) or an absolute path. Pass an optional \`question\` if the user asked something specific.
3. **Answer using the returned description** as if you saw the image. Be natural — don't mention that you used another model unless asked.

## Important

- Never guess or confabulate image contents from the filename or surrounding text. If you have not called \`see_image\`, you have NOT seen the image.
- If the tool cannot find the file, tell the user the filename and ask for a full path or to drag the file into the project directory.
- To inspect a specific detail, pass a targeted \`question\` (e.g. "What error is shown in the terminal?").`

// ─── Plugin export ──────────────────────────────────────────────────────────
const SeeImagePlugin: Plugin = async (ctx) => {
  return {
    tool: {
      see_image: seeImageTool,
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(SYSTEM_INSTRUCTIONS)
    },
  }
}

export default SeeImagePlugin
export { SeeImagePlugin }
