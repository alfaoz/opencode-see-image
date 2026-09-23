// Modern (v2) adapter.
//
// Targets the OpenCode 2.x runtime, whose loader accepts a default export
// shaped `{ id, setup }` (or `{ id, effect }`) and whose plugin API is
// domain-based: `ctx.tool.transform`, `ctx.session.hook`, `ctx.permission.hook`,
// `ctx.catalog.model.list`, …
//
// A v1 runtime rejects this shape ("must default export an object with
// server()"), which is why index.ts exports a single object carrying both
// `server` (v1) and `setup` (v2): each runtime picks the member it knows.

import { autoUpdate, opencodeSpawnSpec } from "opencode-plugin-update-kit"
import path from "path"
import os from "os"
import fs from "fs"
import { spawn } from "node:child_process"
import { EXT_MEDIA, modelSupportsVision, resolveImageV2 } from "./lib.ts"
import {
  CLI_NO_TOOLS_PERMISSION,
  DEFAULT_QUESTION,
  FILEPATH_DESCRIPTION,
  PKG_NAME,
  QUESTION_DESCRIPTION,
  SYSTEM_INSTRUCTIONS,
  TOOL_DESCRIPTION,
  heartbeatBar,
  readProviderKey,
  resolveConfig,
  seeImageViaHTTP,
  type SeeImageOptions,
  type VisionResult,
} from "./core.ts"

const VISION_INDEX_TTL_MS = 30_000

// Extract the assistant's textual answer from a v2 session's message list.
function extractAssistantText(messages: any[]): string {
  return (messages ?? [])
    .filter((m) => m?.type === "assistant")
    .flatMap((m) => m?.content ?? [])
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n")
    .trim()
}

// Build the v2 plugin. `ctx` is the v2 PluginContext; `options` is the config
// options object (ctx.options).
export async function setupV2(ctx: any, options?: SeeImageOptions) {
  const cfg = resolveConfig(options)
  const cwd: string = ctx?.location?.directory ?? process.cwd()

  // Auto-update is best-effort and must never block activation. v2 exposes no
  // client, so the kit falls back to child_process / console logging.
  try {
    void autoUpdate({
      pkgName: PKG_NAME,
      client: undefined,
      importMeta: import.meta,
    })
  } catch {
    // ignore
  }

  // Vision capability of the model most recently used per session, consulted
  // in execute() to fail soft when a vision-capable model calls see_image.
  const sessionVision = new Map<string, boolean>()
  const rememberVision = (sessionID: string | undefined, vision: boolean) => {
    if (!sessionID) return
    if (sessionVision.size > 500) sessionVision.clear()
    sessionVision.set(sessionID, vision)
  }

  // v2 surfaces the active model as a bare `{ id, providerID }` ref, so
  // capabilities are looked up from the catalog instead. The index is built
  // once during setup and refreshed in the background, so the context hook
  // stays synchronous (async hooks do not compose reliably across plugins on
  // the 2.0 beta host).
  let visionIndex = new Map<string, boolean>()
  function rebuildVisionIndex(models: any[]) {
    const next = new Map<string, boolean>()
    for (const model of models ?? []) {
      const id = model?.modelID ?? model?.id
      if (!id) continue
      next.set(
        `${model?.providerID}/${id}`,
        Array.isArray(model?.capabilities?.input)
          ? model.capabilities.input.includes("image")
          : modelSupportsVision(model),
      )
    }
    if (next.size) visionIndex = next
  }
  async function refreshVisionIndex() {
    try {
      const list = await ctx.catalog.model.list()
      rebuildVisionIndex(list?.data ?? list ?? [])
    } catch {
      // keep the previous index; fail open
    }
  }
  await refreshVisionIndex()
  const refreshTimer = setInterval(() => void refreshVisionIndex(), VISION_INDEX_TTL_MS)
  refreshTimer.unref?.()

  function supportsVision(ref: any): boolean {
    if (!ref) return false
    const key = `${ref.providerID}/${ref.id ?? ref.modelID}`
    if (visionIndex.has(key)) return visionIndex.get(key)!
    return modelSupportsVision(ref)
  }

  // Helper sessions created for the vision call. Their tools are stripped in
  // the context hook below (the v2 equivalent of v1's `tools: SDK_NO_TOOLS`),
  // and the permission hook denies any straggler as defense-in-depth.
  const helperSessions = new Set<string>()

  // Prefer the declarative session-scoped rules API when the runtime exposes
  // it (newer v2 builds); fall back to the evaluate hook otherwise.
  let useRulesApi = typeof ctx.permission?.rules === "function"
  if (!useRulesApi && typeof ctx.permission?.hook === "function") {
    try {
      await ctx.permission.hook("evaluate", (input: any) => {
        if (helperSessions.has(input?.sessionID)) input.effect = "deny"
      })
    } catch {
      // older v2 builds may not expose the permission domain; fail open
    }
  }

  // Strip every tool from a helper session's model call.
  async function lockdownHelperSession(sessionID: string) {
    if (!useRulesApi) return
    try {
      await ctx.permission.rules({
        sessionID,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      })
    } catch {
      // rules unsupported at this version; the evaluate hook covers us
      useRulesApi = false
    }
  }

  const ensureTmpFile = (b64: string, ext: string): string | null => {
    const p = path.join(os.tmpdir(), `see-image-${Date.now()}.${ext}`)
    try {
      fs.writeFileSync(p, Buffer.from(b64, "base64"))
      return p
    } catch {
      return null
    }
  }

  // Free opencode models return empty via the SDK, so route them through the
  // local CLI (tool-less via OPENCODE_PERMISSION), exactly as the v1 path does.
  const freeFallback = async (
    modelID: string,
    userPrompt: string,
    b64: string,
    ext: string,
    abort?: AbortSignal,
  ): Promise<string | null> => {
    const filePath = ensureTmpFile(b64, ext)
    if (!filePath) return null
    try {
      return await new Promise<string | null>((resolve) => {
        let out = ""
        let settled = false
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
    } finally {
      try { fs.unlinkSync(filePath) } catch {}
    }
  }

  // Vision call through a throwaway v2 helper session.
  async function seeImageViaV2(
    dataUrl: string,
    mediaType: string,
    prompt: string,
    abort?: AbortSignal,
  ): Promise<VisionResult> {
    const errors: string[] = []
    const b64 = dataUrl.split(",")[1] || ""
    const ext =
      Object.entries(EXT_MEDIA).find(([, m]) => m === mediaType)?.[0] || "png"

    let result: VisionResult | undefined

    const candidates: Array<{ providerID: string; modelID: string }> = []
    if (cfg.routeConfigured) {
      candidates.push({ providerID: cfg.provider, modelID: cfg.model })
    }
    if (
      !(cfg.routeConfigured && cfg.provider === "opencode-go") &&
      readProviderKey("opencode-go")
    ) {
      candidates.push({ providerID: "opencode-go", modelID: "minimax-m3" })
    }
    candidates.push({ providerID: "opencode", modelID: "mimo-v2.5-free" })

    for (const { providerID, modelID } of candidates) {
      if (providerID === "opencode") {
        const text = await freeFallback(modelID, prompt, b64, ext, abort)
        if (text) {
          result = { text, model: modelID, provider: providerID }
          break
        }
        errors.push(`${providerID}/${modelID}: no text from CLI fallback`)
        continue
      }

      let sessionID: string | undefined
      try {
        const session = await ctx.session.create({
          title: "see_image helper",
          model: { id: modelID, providerID },
        })
        sessionID = session?.id ?? session?.data?.id
        if (!sessionID) {
          errors.push(`${providerID}/${modelID}: no session ID`)
          continue
        }
        helperSessions.add(sessionID)
        await lockdownHelperSession(sessionID)

        const onAbort = () => {
          ctx.session.interrupt?.({ sessionID }).catch?.(() => {})
        }
        abort?.addEventListener("abort", onAbort)
        let waitTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await ctx.session.prompt({
            sessionID,
            text: prompt,
            files: [{ uri: `data:${mediaType};base64,${b64}`, name: `see-image.${ext}` }],
          })
          const timedOut = new Promise<never>((_, reject) => {
            waitTimer = setTimeout(
              () => reject(new Error(`session.wait timed out after ${cfg.timeout}ms`)),
              cfg.timeout,
            )
            waitTimer.unref?.()
          })
          await Promise.race([ctx.session.wait({ sessionID }), timedOut])
        } finally {
          if (waitTimer) clearTimeout(waitTimer)
          abort?.removeEventListener("abort", onAbort)
        }

        const messages = await ctx.session.context({ sessionID })
        const text = extractAssistantText(messages)
        if (text) {
          result = { text, model: modelID, provider: providerID }
          break
        }
        errors.push(`${providerID}/${modelID}: no text in response`)
      } catch (e: any) {
        errors.push(`${providerID}/${modelID}: ${e?.message ?? e}`)
      } finally {
        if (sessionID) helperSessions.delete(sessionID)
        // v2 does not expose session removal to plugins, so the helper session
        // is left for the user's own cleanup. It is small and idle.
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
      `see_image: vision call failed for all candidates. ${errMsg}.${hint}`,
    )
  }

  // Register the tool.
  if (ctx.tool?.transform) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "see_image",
        description: TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            filePath: { type: "string", description: FILEPATH_DESCRIPTION },
            question: { type: "string", description: QUESTION_DESCRIPTION },
          },
          additionalProperties: false,
        },
        execute: async (args: any, context: any) => {
          let resolved
          try {
            resolved = await resolveImageV2(
              args.filePath || "",
              cwd,
              context.sessionID,
              (sid: string) => ctx.session.context({ sessionID: sid }),
            )
          } catch (e) {
            if (sessionVision.get(context.sessionID)) {
              return {
                content:
                  "No bridge needed: the current model supports image input natively, " +
                  "so any attached image was already delivered to it directly. Answer " +
                  "from the image you have already seen — do not call see_image again " +
                  "for this attachment.",
                metadata: { skipped: true, reason: "model supports image input" },
              }
            }
            throw e
          }

          const prompt =
            args.question && args.question.trim().length > 0
              ? args.question
              : DEFAULT_QUESTION

          const started = Date.now()
          let tick = 0
          const heartbeat = setInterval(() => {
            const secs = Math.round((Date.now() - started) / 1000)
            try {
              // progress is cosmetic; swallow any rejection so it can never
              // affect the vision call.
              void Promise.resolve(
                context.progress?.({
                  title: `see_image ${heartbeatBar(++tick)} looking… ${secs}s`,
                  working: true,
                  elapsedSeconds: secs,
                }),
              ).catch(() => {})
            } catch {
              // progress is cosmetic
            }
          }, 500)

          let result: VisionResult
          try {
            if (cfg.apiKey) {
              const b64 = resolved.dataUrl.split(",")[1] || ""
              result = await seeImageViaHTTP(b64, resolved.mediaType, prompt, cfg, context.signal)
            } else {
              result = await seeImageViaV2(
                resolved.dataUrl,
                resolved.mediaType,
                prompt,
                context.signal,
              )
            }
          } finally {
            clearInterval(heartbeat)
          }

          return {
            content: result.text,
            metadata: {
              model: result.model,
              provider: result.provider,
              source: resolved.source,
            },
          }
        },
      })
    })
  }

  // Inject the see_image instructions for text-only models, and keep the
  // per-session vision flag current.
  if (ctx.session?.hook) {
    await ctx.session.hook("context", (input: any) => {
      // Tool-less helper sessions: strip every tool from the outgoing call.
      if (helperSessions.has(input?.sessionID) && input.tools) {
        for (const name of Object.keys(input.tools)) delete input.tools[name]
        return
      }
      const vision = supportsVision(input?.model)
      rememberVision(input?.sessionID, vision)
      if (vision) return
      input.system.push({ type: "text", text: SYSTEM_INSTRUCTIONS })
    })
  }

  // v2 setup may return a cleanup function; clear the catalog refresh timer.
  return () => clearInterval(refreshTimer)
}
