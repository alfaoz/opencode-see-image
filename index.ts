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
const TIMEOUT = parseInt(process.env.SEE_IMAGE_TIMEOUT || "30000", 10)
// Stall timeout (SDK streaming path): abort only if the model produces no new
// tokens for this long. A slow-but-progressing call keeps running.
const STALL_TIMEOUT = parseInt(process.env.SEE_IMAGE_STALL_TIMEOUT || "60000", 10)
// Optional absolute cap on a single vision call, in ms (0 = no cap).
const MAX_TIMEOUT = parseInt(process.env.SEE_IMAGE_MAX_TIMEOUT || "0", 10)

// Animated heartbeat: a flowing gradient wave shown in the tool title while we
// wait, so the user can see the call is alive and not frozen.
const HEARTBEAT_FRAMES = ["░", "▒", "▓", "█", "▓", "▒", "░"]
function heartbeatBar(tick: number, width = 14): string {
  let s = ""
  for (let i = 0; i < width; i++) {
    s += HEARTBEAT_FRAMES[(i + tick) % HEARTBEAT_FRAMES.length]
  }
  return s
}
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

  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
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
  } finally {
    db?.close()
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

function readProviderKey(providerID: string): string | null {
  try {
    const xdgDataHome = process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "opencode")
      : ""
    const dataDir =
      process.env.OPENCODE_DATA_DIR ||
      xdgDataHome ||
      path.join(os.homedir(), ".local/share/opencode")
    const authPath = path.join(dataDir, "auth.json")
    if (!fs.existsSync(authPath)) return null
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"))
    const entry = auth[providerID]
    if (entry?.type === "api" && entry?.key) return entry.key
    return null
  } catch {
    return null
  }
}

type ProgressFn = (info: { chars: number; preview: string; model: string }) => void

async function seeImageViaSDK(
  client: any,
  dataUrl: string,
  mediaType: string,
  prompt: string,
  abort?: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ text: string; model: string; provider: string }> {
  const errors: string[] = []

  const b64 = dataUrl.split(",")[1] || ""
  const ext =
    Object.entries(EXT_MEDIA).find(([, m]) => m === mediaType)?.[0] || "png"

  // The free CLI fallback needs the image on disk. Write it lazily and only
  // once, so the common SDK/dataURL path never touches the filesystem. Use the
  // real extension so the CLI can sniff the type correctly.
  let tmpPath: string | null = null
  const ensureTmpFile = (): string | null => {
    if (tmpPath) return tmpPath
    const p = path.join(os.tmpdir(), `see-image-${Date.now()}.${ext}`)
    try {
      fs.writeFileSync(p, Buffer.from(b64, "base64"))
      tmpPath = p
    } catch {
      return null
    }
    return tmpPath
  }

  // Two runners back the candidate list:
  //
  // streamViaSDK — subscribes to opencode's event stream so we get text
  //   token-by-token. This drives the live content preview AND token-based
  //   stall detection (abort only after STALL_TIMEOUT of silence). It also
  //   races the prompt against a stall/max rejection, so a hung call can't
  //   block past the stall window even if the abort signal is ignored. Only
  //   used when an event stream is actually available (its whole point).
  //
  // runViaCLI — `opencode run -m <provider>/<model>` via Bun.spawn (killable).
  //   The proven, reliable fallback. It buffers --format json output until
  //   exit, so it gives no live preview, but it returns the full answer.
  const streamViaSDK = async (
    providerID: string,
    modelID: string,
  ): Promise<string | null> => {
    const sessionRes = await Promise.race([
      client.session.create({ body: {} }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`session.create timed out after ${TIMEOUT}ms`)),
          TIMEOUT,
        ),
      ),
    ])
    const sessionID: string | undefined = sessionRes.data?.id
    if (!sessionID) throw new Error("no session ID")

    const cleanupSession = () =>
      client.session.delete({ path: { id: sessionID } }).catch(() => {})

    // The SDK path exists for the live preview; if we can't get an event
    // stream there's nothing to preview or to measure stalls against, so bail
    // and let the loop fall through to the reliable CLI runner.
    let stream: AsyncGenerator<any> | undefined
    try {
      stream = (await client.event.subscribe())?.stream
    } catch {}
    if (!stream) {
      cleanupSession()
      return null
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    abort?.addEventListener("abort", onAbort)

    const partsByID = new Map<string, string>()
    let streamedText = ""
    let lastActivity = Date.now()
    let finished = false

    const consume = (async () => {
      try {
        for await (const ev of stream!) {
          if (finished) break
          const p = ev?.properties?.part
          if (
            ev?.type === "message.part.updated" &&
            p?.type === "text" &&
            p.sessionID === sessionID
          ) {
            partsByID.set(p.id, typeof p.text === "string" ? p.text : "")
            streamedText = [...partsByID.values()].join("\n").trim()
            lastActivity = Date.now()
            onProgress?.({
              chars: streamedText.length,
              preview: streamedText.slice(-200),
              model: modelID,
            })
          }
        }
      } catch {}
    })()

    let stallTimer: ReturnType<typeof setInterval> | undefined
    let maxTimer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_, reject) => {
      stallTimer = setInterval(() => {
        if (Date.now() - lastActivity > STALL_TIMEOUT) {
          controller.abort()
          reject(new Error(`stalled: no tokens for ${STALL_TIMEOUT}ms`))
        }
      }, 1000)
      if (MAX_TIMEOUT > 0) {
        maxTimer = setTimeout(() => {
          controller.abort()
          reject(new Error(`exceeded MAX_TIMEOUT ${MAX_TIMEOUT}ms`))
        }, MAX_TIMEOUT)
      }
    })

    let res: any
    try {
      res = await Promise.race([
        client.session.prompt({
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
          signal: controller.signal,
        }),
        guard,
      ])
    } catch (e: any) {
      // Stalled / aborted / errored — keep whatever streamed in so far.
      if (!streamedText) throw e
    } finally {
      finished = true
      if (stallTimer) clearInterval(stallTimer)
      if (maxTimer) clearTimeout(maxTimer)
      try { await stream.return?.(undefined) } catch {}
      abort?.removeEventListener("abort", onAbort)
      cleanupSession()
    }

    const finalText = (res?.data?.parts ?? [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .filter((t: any) => typeof t === "string" && t.length > 0)
      .join("\n")
      .trim()

    return finalText || streamedText || null
  }

  const runViaCLI = async (
    providerID: string,
    modelID: string,
  ): Promise<string | null> => {
    const filePath = ensureTmpFile()
    if (!filePath) return null
    onProgress?.({ chars: 0, preview: "", model: modelID })

    const proc = Bun.spawn(
      [
        "opencode",
        "run",
        "-f",
        filePath,
        "-m",
        `${providerID}/${modelID}`,
        prompt,
        "--format",
        "json",
        "--dangerously-skip-permissions",
      ],
      { stdout: "pipe", stderr: "ignore" },
    )
    const onAbort = () => proc.kill()
    abort?.addEventListener("abort", onAbort)
    const maxTimer =
      MAX_TIMEOUT > 0 ? setTimeout(() => proc.kill(), MAX_TIMEOUT) : undefined

    try {
      const out = await new Response(proc.stdout).text()
      await proc.exited
      const parts = new Map<string, string>()
      for (const line of out.split("\n").filter(Boolean)) {
        try {
          const p = JSON.parse(line)?.part
          if (p?.type === "text" && typeof p.text === "string") {
            parts.set(p.id ?? String(parts.size), p.text)
          }
        } catch {}
      }
      return [...parts.values()].join("\n").trim() || null
    } catch {
      return null
    } finally {
      if (maxTimer) clearTimeout(maxTimer)
      abort?.removeEventListener("abort", onAbort)
    }
  }

  let result: { text: string; model: string; provider: string } | undefined

  try {
    const candidates: Array<{
      providerID: string
      modelID: string
      mode: "sdk" | "cli"
    }> = []
    const envProvider = process.env.SEE_IMAGE_PROVIDER
    const envModel = process.env.SEE_IMAGE_MODEL
    if (envProvider && envModel) {
      candidates.push({ providerID: envProvider, modelID: envModel, mode: "sdk" })
    }
    // Prefer streaming minimax (live preview); fall back to the same model via
    // the proven CLI runner; then the free model via CLI.
    candidates.push({ providerID: "opencode-go", modelID: "minimax-m3", mode: "sdk" })
    candidates.push({ providerID: "opencode-go", modelID: "minimax-m3", mode: "cli" })
    candidates.push({ providerID: "opencode", modelID: "mimo-v2.5-free", mode: "cli" })

    for (const { providerID, modelID, mode } of candidates) {
      try {
        const text =
          mode === "sdk"
            ? await streamViaSDK(providerID, modelID)
            : await runViaCLI(providerID, modelID)
        if (text) {
          result = { text, model: modelID, provider: providerID }
          break
        }
        errors.push(`${providerID}/${modelID} (${mode}): no text`)
      } catch (e: any) {
        errors.push(`${providerID}/${modelID} (${mode}): ${e?.message ?? e}`)
      }
    }

    if (!result) {
      const apiKey =
        process.env.SEE_IMAGE_API_KEY ||
        (process.env.SEE_IMAGE_PROVIDER &&
          readProviderKey(process.env.SEE_IMAGE_PROVIDER)) ||
        readProviderKey("opencode-go")
      if (apiKey) {
        try {
          result = await seeImageViaHTTP(b64, mediaType, prompt, abort, apiKey)
        } catch (e: any) {
          errors.push(`http-fallback: ${e?.message ?? e}`)
        }
      }
    }

    if (result) return result

    const errMsg = errors.join("; ")
    const hint = errMsg.includes("usage limit")
      ? ` Enable usage from your balance in your opencode workspace at https://opencode.ai/workspace`
      : ""
    throw new Error(
      `see_image: SDK vision call failed for all candidates. ${errMsg}.${hint}`,
    )
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath) } catch {}
    }
  }
}

async function seeImageViaHTTP(
  b64: string,
  mediaType: string,
  prompt: string,
  abort?: AbortSignal,
  keyOverride?: string,
): Promise<{ text: string; model: string; provider: string }> {
  const key = keyOverride || process.env.SEE_IMAGE_API_KEY!
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

You have a \`see_image\` tool. When the user attaches an image, opencode rejects it and you receive an error string containing the **filename**. You MUST call \`see_image\` to actually view it — do NOT just tell the user about the error.

## When you MUST call \`see_image\`

Call \`see_image\` immediately in ALL these cases — do not inform the user, do not ask for confirmation:

1. You receive an error containing \`Cannot read "Screenshot ..."\` or \`Cannot read "...png"\` or \`Cannot read "...jpg"\`
2. The error message says \`this model does not support image input\`
3. The error starts with \`ERROR:\` and mentions an image file
4. The user references an image/screenshot ("see this", "look at this", ".png", ".jpg")
5. The user pastes an image path

## How to use it

1. Extract the filename from the error (it's in quotes in the error message, e.g. \`Screenshot 2026-06-19 at 02.18.53.png\`)
2. Call \`see_image\` with \`filePath\` set to that bare filename
3. Optionally pass a \`question\` if the user asked something specific
4. Answer using the returned description as if you saw the image. Be natural.

## Important

- NEVER just repeat the error to the user. Call the tool.
- If \`see_image\` cannot find the file, tell the user the filename and ask for an absolute path.
- Do NOT use \`see_image\` for text files (\`.ts\`, \`.md\`, \`.json\`, etc.) — use \`read\` instead.
- Never guess image contents. If you haven't called \`see_image\`, you haven't seen the image.`

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
          [
            "What to ask the vision model. Omit for a general detailed description.",
            "Tailor it to the situation for much better results:",
            '- Reading/transcribing text or code: "Transcribe all text exactly, preserving layout, line breaks, and code indentation."',
            '- An error or stack trace screenshot: "Quote the exact error message and stack trace, then state the likely cause."',
            '- Reproducing a UI as code: "Describe the layout, components, text, colors, and spacing precisely enough to rebuild this UI in code."',
            '- A technical diagram/architecture: "Explain this diagram: list each component and the relationships and data/flow direction between them."',
            '- A chart/graph/dashboard: "Read this visualization: axes, series, key values, and the main takeaway."',
            '- Comparing against an expected design: "Describe this UI in detail so it can be diffed against an expected layout (note any visible defects or misalignment)."',
            "Otherwise pass the user's own specific question verbatim.",
          ].join("\n"),
        ),
    },
    async execute(args, context) {
      const resolved = resolveImage(args.filePath, context.directory, context.sessionID)

      const prompt =
        args.question && args.question.trim().length > 0
          ? args.question
          : "Describe this image in detail. If it is a screenshot, describe the UI, text content, and layout precisely. This description will be used by another model to answer the user, so be thorough and accurate."

      let result: { text: string; model: string; provider: string }

      // Live feedback while we wait: an animated heartbeat bar plus, once the
      // vision model starts streaming, a growing char count and a preview of
      // the latest text. The timer ticks independently so the bar animates
      // even before any tokens arrive; onProgress feeds it streamed content.
      const started = Date.now()
      let tick = 0
      const live = { chars: 0, preview: "", model: "" }
      const onProgress: ProgressFn = (info) => {
        live.chars = info.chars
        live.preview = info.preview
        if (info.model) live.model = info.model
      }
      const render = () => {
        const secs = Math.round((Date.now() - started) / 1000)
        const bar = heartbeatBar(++tick)
        const label = live.chars > 0 ? `reading… ${live.chars} chars` : "looking…"
        const model = live.model ? ` · ${live.model}` : ""
        context.metadata({
          title: `see_image ${bar} ${label} · ${secs}s${model}`,
          metadata: {
            elapsedSeconds: secs,
            chars: live.chars,
            preview: live.preview,
            model: live.model,
          },
        })
      }
      render()
      const heartbeat = setInterval(render, 500)

      try {
        if (process.env.SEE_IMAGE_API_KEY) {
          const b64 = resolved.dataUrl.split(",")[1] || ""
          result = await seeImageViaHTTP(
            b64,
            resolved.mediaType,
            prompt,
            context.abort,
          )
        } else {
          result = await seeImageViaSDK(
            client,
            resolved.dataUrl,
            resolved.mediaType,
            prompt,
            context.abort,
            onProgress,
          )
        }
      } finally {
        clearInterval(heartbeat)
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
