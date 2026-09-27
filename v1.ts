// Legacy (v1) adapter.
//
// Targets `opencode` 1.x, whose loader accepts a default export shaped
// `{ id, server }` and whose hook surface is `tool` / `event` /
// `chat.params` / `experimental.chat.system.transform`.
//
// The v2 runtime also accepts this shape (it ignores `server` and uses
// `setup`), so loading this file never breaks a v2 install.

import { tool } from "@opencode-ai/plugin"
import { autoUpdate, opencodeSpawnSpec } from "opencode-plugin-update-kit"
import path from "path"
import os from "os"
import fs from "fs"
import { spawn } from "node:child_process"
import { EXT_MEDIA, modelSupportsVision, resolveImage } from "./lib.ts"
import {
  CLI_NO_TOOLS_PERMISSION,
  DEFAULT_QUESTION,
  FILEPATH_DESCRIPTION,
  PKG_NAME,
  QUESTION_DESCRIPTION,
  SDK_NO_TOOLS,
  SYSTEM_INSTRUCTIONS,
  TOOL_DESCRIPTION,
  heartbeatBar,
  readProviderKey,
  resolveConfig,
  seeImageViaHTTP,
  type SeeImageConfig,
  type SeeImageOptions,
  type VisionResult,
} from "./core.ts"

// Deleting the helper session the moment prompt() resolves races opencode's
// event projection — late part writes then hit a deleted parent row and the
// user sees a failed-query DB error (issue #5). Defer deletion until the
// session goes idle plus a settle delay, with a slow timer as backstop for
// the case where the idle event slipped past before cleanup was scheduled.
const CLEANUP_SETTLE_MS = 2_000
const CLEANUP_FALLBACK_MS = 60_000
const pendingCleanup = new Map<string, ReturnType<typeof setTimeout>>()

function deleteSessionNow(client: any, sessionID: string) {
  const timer = pendingCleanup.get(sessionID)
  if (timer) clearTimeout(timer)
  pendingCleanup.delete(sessionID)
  client.session.delete({ path: { id: sessionID } }).catch(() => {})
}

function scheduleSessionCleanup(client: any, sessionID: string) {
  const timer = setTimeout(
    () => deleteSessionNow(client, sessionID),
    CLEANUP_FALLBACK_MS,
  )
  timer.unref?.()
  pendingCleanup.set(sessionID, timer)
}

function onSessionIdle(client: any, sessionID: string | undefined) {
  if (!sessionID) return
  const timer = pendingCleanup.get(sessionID)
  if (!timer) return
  clearTimeout(timer)
  const settle = setTimeout(
    () => deleteSessionNow(client, sessionID),
    CLEANUP_SETTLE_MS,
  )
  settle.unref?.()
  pendingCleanup.set(sessionID, settle)
}

async function seeImageViaSDK(
  client: any,
  dataUrl: string,
  mediaType: string,
  prompt: string,
  cfg: SeeImageConfig,
  abort?: AbortSignal,
): Promise<VisionResult> {
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
      ])
      // No --dangerously-skip-permissions (issue #6): that auto-approved any
      // tool the vision model reached for. Instead the child gets a deny-all
      // permission config, so no tool is ever offered or approved; the -f
      // image is ingested client-side by the CLI and needs no read tool.
      const proc = spawn(spec.cmd, spec.args, {
        stdio: ["ignore", "pipe", "ignore"],
        ...spec.options,
        env: { ...process.env, OPENCODE_PERMISSION: CLI_NO_TOOLS_PERMISSION },
      })
      const timer = setTimeout(() => proc.kill(), cfg.timeout)
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

  let result: VisionResult | undefined

  try {
    const candidates: Array<{ providerID: string; modelID: string }> = []
    if (cfg.routeConfigured) {
      candidates.push({ providerID: cfg.provider, modelID: cfg.model })
    }
    // Only try the paid opencode-go model if the user actually has that sub
    // connected. Free/Zen-only users otherwise hit a fatal
    // ProviderModelNotFoundError before ever reaching the free fallback below.
    if (
      !(cfg.routeConfigured && cfg.provider === "opencode-go") &&
      readProviderKey("opencode-go")
    ) {
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
              () => reject(new Error(`session.create timed out after ${cfg.timeout}ms`)),
              cfg.timeout,
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
        const timer = setTimeout(() => controller.abort(), cfg.timeout)
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
              tools: SDK_NO_TOOLS,
              system:
                "You are a vision assistant with no tools. Describe the image accurately and concisely. Answer with text only; never attempt to run commands or call tools.",
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
        if (sessionID) scheduleSessionCleanup(client, sessionID)
      }
    }

    if (!result) {
      const apiKey =
        cfg.apiKey ||
        (cfg.provider && readProviderKey(cfg.provider)) ||
        readProviderKey("opencode-go")
      if (apiKey) {
        try {
          result = await seeImageViaHTTP(b64, mediaType, prompt, cfg, abort, apiKey)
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

// Build the v1 Hooks object. `ctx` is the legacy PluginInput; `options` is the
// tuple form from the config (`["opencode-see-image", { ... }]`).
export async function createV1Hooks(ctx: any, options?: SeeImageOptions) {
  const { client, $ } = ctx
  const cfg = resolveConfig(options)

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
    description: TOOL_DESCRIPTION,
    args: {
      filePath: tool.schema.string().optional().describe(FILEPATH_DESCRIPTION),
      question: tool.schema.string().optional().describe(QUESTION_DESCRIPTION),
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
          : DEFAULT_QUESTION

      let result: VisionResult

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
        if (cfg.apiKey) {
          const b64 = resolved.dataUrl.split(",")[1] || ""
          result = await seeImageViaHTTP(b64, resolved.mediaType, prompt, cfg, context.abort)
        } else {
          result = await seeImageViaSDK(
            client,
            resolved.dataUrl,
            resolved.mediaType,
            prompt,
            cfg,
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
    event: async ({ event }: any) => {
      if (event.type === "session.idle") {
        onSessionIdle(client, (event.properties as any)?.sessionID)
      }
    },
    // chat.params fires on every request and always carries the sessionID,
    // so it keeps sessionVision fresh even when system.transform's optional
    // sessionID is absent (and when the user switches models mid-session).
    "chat.params": async (input: any, _output: any) => {
      rememberVision(input.sessionID, input.model)
    },
    "experimental.chat.system.transform": async (input: any, output: any) => {
      rememberVision(input.sessionID, input.model)
      // Vision-capable models see attachments natively — injecting the
      // see_image instructions there only provokes pointless tool calls
      // that then fail cosmetically (issue #3).
      if (modelSupportsVision(input.model)) return
      output.system.push(SYSTEM_INSTRUCTIONS)
    },
  }
}
