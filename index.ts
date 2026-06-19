import { tool } from "@opencode-ai/plugin"
import { autoUpdate } from "opencode-plugin-update-kit"
import path from "path"
import os from "os"
import fs from "fs"
import { Database } from "bun:sqlite"
import type { Plugin } from "@opencode-ai/plugin"

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

type ResolvedImage = {
  dataUrl: string
  mediaType: string
  source: string
}

function opencodeDbPath(): string {
  const dataDir =
    process.env.OPENCODE_DATA_DIR ||
    process.env.XDG_DATA_HOME ||
    path.join(os.homedir(), ".local/share/opencode")
  return path.join(dataDir, "opencode.db")
}

function resolveFromDb(
  filename: string,
  sessionID?: string,
): ResolvedImage | null {
  const dbPath = opencodeDbPath()
  if (!fs.existsSync(dbPath)) return null

  try {
    const db = new Database(dbPath, { readonly: true })
    let rows: Array<{ data: string }>

    if (!filename || filename === "clipboard") {
      // No filename: get the most recent file part, scoped to the current
      // session if known so we don't grab an image pasted into a different
      // conversation.
      if (sessionID) {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE session_id = ?
               AND json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.url') LIKE 'data:%'
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all(sessionID) as Array<{ data: string }>
      } else {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.url') LIKE 'data:%'
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all() as Array<{ data: string }>
      }
    } else {
      if (sessionID) {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE session_id = ?
               AND json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.filename') = ?
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all(sessionID, filename) as Array<{ data: string }>
      } else {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.filename') = ?
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all(filename) as Array<{ data: string }>
      }
    }

    db.close()

    if (!rows.length) return null
    const part = JSON.parse(rows[0].data)
    const url: string = part.url || ""
    if (!url.startsWith("data:")) return null

    return {
      dataUrl: url,
      mediaType: part.mime || "image/png",
      source: "opencode-db",
    }
  } catch {
    return null
  }
}

function resolveFromFilesystem(
  name: string,
  cwd: string,
): ResolvedImage | null {
  let absPath: string | null = null

  // Expand tilde to home directory
  if (name.startsWith("~")) {
    name = path.join(os.homedir(), name.slice(1))
  }

  if (path.isAbsolute(name) && fs.existsSync(name)) {
    absPath = name
  } else {
    const resolved = path.resolve(cwd, name)
    if (fs.existsSync(resolved)) absPath = resolved
  }

  if (!absPath) {
    const tmpdir = process.env.TMPDIR || "/tmp"
    const searchDirs: string[] = []
    const tempItems = path.join(tmpdir, "TemporaryItems")
    if (fs.existsSync(tempItems)) {
      try {
        for (const sub of fs.readdirSync(tempItems, { withFileTypes: true })) {
          if (
            sub.isDirectory() &&
            sub.name.startsWith("NSIRD_screencaptureui")
          ) {
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
        if (fs.existsSync(full)) {
          absPath = full
          break
        }
      } catch {}
    }
  }

  if (!absPath || !fs.existsSync(absPath)) return null

  const ext = path.extname(absPath).slice(1).toLowerCase()
  const mediaType = EXT_MEDIA[ext] || "image/png"
  const b64 = Buffer.from(fs.readFileSync(absPath)).toString("base64")

  return {
    dataUrl: `data:${mediaType};base64,${b64}`,
    mediaType,
    source: absPath,
  }
}

function resolveImage(name: string, cwd: string, sessionID?: string): ResolvedImage {
  // DB first: handles clipboard pastes, dragged files, screenshots.
  // For "clipboard" or empty name, gets the most recent file part.
  // Scoped to the current session if known.
  const fromDb = resolveFromDb(name, sessionID)
  if (fromDb) return fromDb

  // Filesystem fallback for files not yet in the DB.
  const fromFs = resolveFromFilesystem(name, cwd)
  if (fromFs) return fromFs

  throw new Error(
    `see_image: could not find "${name}". Searched opencode DB and filesystem. Pass an absolute filePath instead.`,
  )
}

async function seeImageViaSDK(
  client: any,
  dataUrl: string,
  mediaType: string,
  prompt: string,
  abort?: AbortSignal,
): Promise<{ text: string; model: string; provider: string }> {
  const envProvider = process.env.SEE_IMAGE_PROVIDER
  const envModel = process.env.SEE_IMAGE_MODEL
  const candidates: Array<{ providerID: string; modelID: string }> = []
  if (envProvider && envModel) {
    candidates.push({ providerID: envProvider, modelID: envModel })
  }
  candidates.push({ providerID: "opencode-go", modelID: "minimax-m3" })
  candidates.push({ providerID: "opencode", modelID: "big-pickle" })

  const errors: string[] = []

  for (const { providerID, modelID } of candidates) {
    let sessionID: string | undefined
    try {
      const sessionRes = await client.session.create({ body: {} })
      sessionID = sessionRes.data?.id
      if (!sessionID) {
        errors.push(`${providerID}/${modelID}: no session ID`)
        continue
      }

      const result = await client.session.prompt({
        path: { id: sessionID },
        body: {
          model: { providerID, modelID },
          parts: [
            { type: "file", mime: mediaType, url: dataUrl },
            { type: "text", text: prompt },
          ],
          tools: {},
          system:
            "You are a vision assistant. Describe the image accurately and concisely. Answer with text only.",
        },
      })

      const parts = result.data?.parts ?? []
      const text = (parts as any[])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .filter((t: any) => typeof t === "string" && t.length > 0)
        .join("\n")
        .trim()

      if (text) {
        return { text, model: modelID, provider: providerID }
      }
      errors.push(`${providerID}/${modelID}: no text in response`)
    } catch (e: any) {
      errors.push(`${providerID}/${modelID}: ${e?.message ?? e}`)
    } finally {
      if (sessionID) {
        await client.session
          .delete({ path: { id: sessionID } })
          .catch(() => {})
      }
    }
  }

  throw new Error(
    `see_image: SDK vision call failed for all candidates. ${errors.join("; ")}`,
  )
}

async function seeImageViaHTTP(
  b64: string,
  mediaType: string,
  prompt: string,
  abort?: AbortSignal,
): Promise<{ text: string; model: string; provider: string }> {
  const key = process.env.SEE_IMAGE_API_KEY!
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

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: abort,
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(
      `see_image: HTTP vision call to "${MODEL}" failed: HTTP ${res.status}, ${errText.slice(0, 300)}`,
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
      `see_image: model "${MODEL}" returned no text. Response: ${JSON.stringify(data).slice(0, 300)}`,
    )
  }

  return { text, model: MODEL, provider: PROVIDER_ID }
}

const SYSTEM_INSTRUCTIONS = `# See Image (vision bridge), opencode-see-image plugin

You have access to a \`see_image\` tool. The current model may not support image input directly. When a user attaches a screenshot or image, opencode rejects it and you only receive an error string containing the **filename**, no path, no pixels. Use \`see_image\` to actually view it.

## When to use \`see_image\`

Use ONLY when one of these is true:
1. You receive an error like: \`Cannot read "Screenshot ....png" (this model does not support image input)\`
2. The user references an image/screenshot they expect you to see ("see this", "look at this", "can you see this", ".png"/".jpg")
3. The user pastes an image path they want you to inspect

Do NOT use \`see_image\` for reading text files, use the \`read\` tool for those.

## How to use it

1. **Extract the filename** from the error string (the quoted name), or use the path the user gave.
2. **Call \`see_image\`** with \`filePath\` set to the bare filename (it auto-locates) or an absolute path. Pass an optional \`question\` if the user asked something specific.
3. **Answer using the returned description** as if you saw the image. Be natural, don't mention that you used another model unless asked.

## Important

- Never guess or confabulate image contents from the filename or surrounding text. If you have not called \`see_image\`, you have NOT seen the image.
- If the tool cannot find the file, tell the user the filename and ask for a full path or to drag the file into the project directory.
- To inspect a specific detail, pass a targeted \`question\` (e.g. "What error is shown in the terminal?").`

const PKG_NAME = "opencode-see-image"

const SeeImagePlugin: Plugin = async (ctx) => {
  const { client, $ } = ctx

  autoUpdate({
    pkgName: PKG_NAME,
    client,
    $,
    importMeta: import.meta,
  })

  const seeImageTool = tool({
    description:
      'See an image/screenshot that the current model cannot view. Use when the user attaches an image and you get a "this model does not support image input" / "Cannot read" error, or when a screenshot/image is referenced ("see this", "can you see", .png/.jpg). Routes the image to a vision-capable model and returns a detailed textual description you can reason about as if you saw it. Pass filePath as an absolute path OR a bare filename (auto-located from opencode DB or filesystem).',
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
      const resolved = resolveImage(args.filePath, context.directory, context.sessionID)

      const prompt =
        args.question && args.question.trim().length > 0
          ? args.question
          : "Describe this image in detail. If it is a screenshot, describe the UI, text content, and layout precisely. This description will be used by another model to answer the user, so be thorough and accurate."

      let result: { text: string; model: string; provider: string }

      if (process.env.SEE_IMAGE_API_KEY) {
        const b64 = resolved.dataUrl.split(",")[1] || ""
        result = await seeImageViaHTTP(b64, resolved.mediaType, prompt, context.abort)
      } else {
        result = await seeImageViaSDK(
          client,
          resolved.dataUrl,
          resolved.mediaType,
          prompt,
          context.abort,
        )
      }

      context.metadata({
        title: `see_image: ${args.filePath}`,
        metadata: {
          model: result.model,
          provider: result.provider,
          source: resolved.source,
        },
      })

      return result.text
    },
  })

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
