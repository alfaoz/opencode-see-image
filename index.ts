import { tool } from "@opencode-ai/plugin"
import { autoUpdate, opencodeSpawnSpec } from "opencode-plugin-update-kit"
import path from "path"
import os from "os"
import fs from "fs"
import { spawn } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"
import {
  EXT_MEDIA,
  modelSupportsVision,
  opencodeDataDirs,
  resolveImage,
} from "./lib.ts"

const ENDPOINT =
  process.env.SEE_IMAGE_ENDPOINT ||
  "https://opencode.ai/zen/go/v1/messages"
const MODEL = process.env.SEE_IMAGE_MODEL || "minimax-m3"
const PROVIDER_ID = process.env.SEE_IMAGE_PROVIDER || "opencode-go"
const TIMEOUT = parseInt(process.env.SEE_IMAGE_TIMEOUT || "30000", 10)
const API_VERSION = process.env.SEE_IMAGE_API_VERSION || "2023-06-01"
const USER_AGENT =
  process.env.SEE_IMAGE_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

// Animated heartbeat shown in the tool title while we wait, so the user can
// see the call is alive. Purely cosmetic — never touches the vision call.
const HEARTBEAT_FRAMES = ["░", "▒", "▓", "█", "▓", "▒", "░"]
function heartbeatBar(tick: number, width = 12): string {
  let s = ""
  for (let i = 0; i < width; i++) {
    s += HEARTBEAT_FRAMES[(i + tick) % HEARTBEAT_FRAMES.length]
  }
  return s
}

function readProviderKey(providerID: string): string | null {
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

async function seeImageViaSDK(
  client: any,
  dataUrl: string,
  mediaType: string,
  prompt: string,
  abort?: AbortSignal,
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

  // For free opencode models, use CLI instead of SDK (SDK returns empty).
  // child_process.spawn works on both Bun and Node and gives us a killable
  // handle; we kill the child on both timeout and external abort.
  const freeFallback = async (modelID: string, userPrompt: string): Promise<string | null> => {
    const filePath = ensureTmpFile()
    if (!filePath) return null
    return await new Promise<string | null>((resolve) => {
      let out = ""
      let settled = false
      // opencodeSpawnSpec handles Windows, where the CLI is an .exe or npm
      // .cmd shim that a bare spawn("opencode") cannot start.
      const spec = opencodeSpawnSpec("opencode", [
        "run",
        "-f",
        filePath,
        "-m",
        `opencode/${modelID}`,
        userPrompt,
        "--format",
        "json",
        "--dangerously-skip-permissions",
      ])
      const proc = spawn(spec.cmd, spec.args, {
        stdio: ["ignore", "pipe", "ignore"],
        ...spec.options,
      })
      const timer = setTimeout(() => proc.kill(), TIMEOUT)
      const onAbort = () => proc.kill()
      abort?.addEventListener("abort", onAbort)
      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abort?.removeEventListener("abort", onAbort)
        resolve(value)
      }
      proc.stdout?.on("data", (chunk) => (out += chunk))
      proc.on("error", () => finish(null))
      proc.on("close", () => {
        for (const line of out.split("\n").filter(Boolean)) {
          try {
            const parsed = JSON.parse(line)
            if (parsed?.part?.type === "text" && parsed?.part?.text) {
              return finish(parsed.part.text)
            }
          } catch {}
        }
        finish(null)
      })
    })
  }

  let result: { text: string; model: string; provider: string } | undefined

  try {
    const candidates: Array<{ providerID: string; modelID: string }> = []
    const envProvider = process.env.SEE_IMAGE_PROVIDER
    const envModel = process.env.SEE_IMAGE_MODEL
    if (envProvider && envModel) {
      candidates.push({ providerID: envProvider, modelID: envModel })
    }
    // Only try the paid opencode-go model if the user actually has that sub
    // connected. Free/Zen-only users otherwise hit a fatal
    // ProviderModelNotFoundError before ever reaching the free fallback below.
    if (envProvider !== "opencode-go" && readProviderKey("opencode-go")) {
      candidates.push({ providerID: "opencode-go", modelID: "minimax-m3" })
    }
    candidates.push({ providerID: "opencode", modelID: "mimo-v2.5-free" })

    for (const { providerID, modelID } of candidates) {
      if (providerID === "opencode") {
        // SDK session.prompt returns empty for free models; use CLI instead
        const text = await freeFallback(modelID, prompt)
        if (text) {
          result = { text, model: modelID, provider: providerID }
          break
        }
        errors.push(`${providerID}/${modelID}: no text from CLI fallback`)
        continue
      }

      let sessionID: string | undefined
      try {
        const sessionRes = await Promise.race([
          client.session.create({ body: {} }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`session.create timed out after ${TIMEOUT}ms`)),
              TIMEOUT,
            ),
          ),
        ])
        sessionID = sessionRes.data?.id
        if (!sessionID) {
          errors.push(`${providerID}/${modelID}: no session ID`)
          continue
        }

        const controller = new AbortController()
        const onAbort = () => controller.abort()
        abort?.addEventListener("abort", onAbort)
        const timer = setTimeout(() => controller.abort(), TIMEOUT)
        let res
        try {
          res = await client.session.prompt({
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
          })
        } finally {
          clearTimeout(timer)
          abort?.removeEventListener("abort", onAbort)
        }

        const parts = res.data?.parts ?? []
        const text = (parts as any[])
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .filter((t: any) => typeof t === "string" && t.length > 0)
          .join("\n")
          .trim()

        if (text) {
          result = { text, model: modelID, provider: providerID }
          break
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

const PKG_NAME = "opencode-see-image"

const SeeImagePlugin: Plugin = async (ctx) => {
  const { client, $ } = ctx

  autoUpdate({
    pkgName: PKG_NAME,
    client,
    $,
    importMeta: import.meta,
  })

  // Vision capability of the model most recently used per session. Populated
  // by the chat hooks below (which always run before the model can call any
  // tool), consulted in execute() to fail soft when a vision-capable model
  // calls see_image anyway.
  const sessionVision = new Map<string, boolean>()
  const rememberVision = (sessionID: string | undefined, model: unknown) => {
    if (!sessionID) return
    if (sessionVision.size > 500) sessionVision.clear()
    sessionVision.set(sessionID, modelSupportsVision(model))
  }

  const seeImageTool = tool({
    description:
      'See an image/screenshot that the current model cannot view. Use when the user attaches an image and you get a "this model does not support image input" / "Cannot read" error, when the message contains an image placeholder like [Image #1], or when a screenshot/image is referenced ("see this", "can you see", .png/.jpg). Routes the image to a vision-capable model and returns a detailed textual description you can reason about as if you saw it. Pass filePath as an absolute path or bare filename, or omit it to use the most recently attached image in this conversation. Do NOT call this if you can already view images natively — you have already seen any attached image directly.',
    args: {
      filePath: tool.schema
        .string()
        .optional()
        .describe(
          'Path to the image. Absolute path, or a bare filename like "Screenshot 2026-06-18 at 17.32.24.png" to auto-locate. Omit entirely (or pass "latest") to use the most recent image attached to this conversation.',
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
            '- A UI/screen where positions matter (alignment bugs, "where is X", overlapping or misplaced elements): "Describe the layout and include a labeled ASCII diagram of the spatial arrangement of elements."',
            '- A chart/graph/dashboard: "Read this visualization: axes, series, key values, and the main takeaway."',
            '- Comparing against an expected design: "Describe this UI in detail so it can be diffed against an expected layout (note any visible defects or misalignment)."',
            'Otherwise pass the user\'s own specific question verbatim. If the question concerns a UI/screen and spatial arrangement matters to answering it, append: "Also include a labeled ASCII diagram of the layout."',
          ].join("\n"),
        ),
    },
    async execute(args, context) {
      let resolved
      try {
        resolved = await resolveImage(
          args.filePath || "",
          context.directory,
          context.sessionID,
          client,
        )
      } catch (e) {
        // Vision-capable models receive attachments natively, which consumes
        // the image before we can find it — the model already saw it, so a
        // hard error here is pure noise (issue #3). Fail soft instead.
        if (sessionVision.get(context.sessionID)) {
          context.metadata({
            title: "see_image: not needed (model has native vision)",
            metadata: { skipped: true, reason: "model supports image input" },
          })
          return (
            "No bridge needed: the current model supports image input natively, " +
            "so any attached image was already delivered to it directly. Answer " +
            "from the image you have already seen — do not call see_image again " +
            "for this attachment."
          )
        }
        throw e
      }

      const prompt =
        args.question && args.question.trim().length > 0
          ? args.question
          : "Describe this image in detail. If it is a screenshot, describe the UI, text content, and layout precisely. This description will be used by another model to answer the user, so be thorough and accurate."

      let result: { text: string; model: string; provider: string }

      // Animated heartbeat while we wait. Runs on a timer independent of the
      // vision call — it only updates the tool title/metadata, so it can never
      // affect whether the image is seen.
      const started = Date.now()
      let tick = 0
      const render = () => {
        const secs = Math.round((Date.now() - started) / 1000)
        context.metadata({
          title: `see_image ${heartbeatBar(++tick)} looking… ${secs}s`,
          metadata: { working: true, elapsedSeconds: secs },
        })
      }
      render()
      const heartbeat = setInterval(render, 500)

      try {
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
      } finally {
        clearInterval(heartbeat)
      }

      context.metadata({
        title: `see_image: ${args.filePath || "latest image"}`,
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
    // chat.params fires on every request and always carries the sessionID,
    // so it keeps sessionVision fresh even when system.transform's optional
    // sessionID is absent (and when the user switches models mid-session).
    "chat.params": async (input, _output) => {
      rememberVision(input.sessionID, input.model)
    },
    "experimental.chat.system.transform": async (input, output) => {
      rememberVision(input.sessionID, input.model)
      // Vision-capable models see attachments natively — injecting the
      // see_image instructions there only provokes pointless tool calls
      // that then fail cosmetically (issue #3).
      if (modelSupportsVision(input.model)) return
      output.system.push(SYSTEM_INSTRUCTIONS)
    },
  }
}

// The ONLY export. opencode's legacy plugin loader invokes every exported
// function as a plugin factory, so helper exports here would crash the whole
// plugin at load time (this actually happened — helpers live in lib.ts now).
export default SeeImagePlugin
