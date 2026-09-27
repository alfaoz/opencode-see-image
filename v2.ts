// Modern (v2) adapter.
//
// Targets the OpenCode 2.x runtime, whose loader accepts a default export
// shaped `{ id, setup }` (or `{ id, effect }`) and whose plugin API is
// domain-based: `ctx.tool.transform`, `ctx.session.hook`, `ctx.model.list`, …
//
// A v1 runtime rejects this shape ("must default export an object with
// server()"), which is why index.ts exports a single object carrying both
// `server` (v1) and `setup` (v2): each runtime picks the member it knows.
//
// Deliberately absent compared to v1: the `opencode run` CLI fallback for
// free models. v2's `run` ignores OPENCODE_PERMISSION, so the child would get
// the user's full toolset (issue #6). Free models go through the tool-less
// helper session instead.

import { autoUpdate } from "opencode-plugin-update-kit"
import { EXT_MEDIA, modelSupportsVision, resolveImageV2 } from "./lib.ts"
import {
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

// The v2 counterpart of v1's SDK_NO_TOOLS (issue #6), applied when the helper
// session is created. Session rules are merged last and evaluated last-match-
// wins, so this beats any user "allow"; a wholly denied action is also dropped
// from the tool snapshot, so the vision model is offered no tools at all.
const HELPER_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" as const }]

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

// Build the v2 plugin. `ctx` is the v2 plugin Context; `options` is the config
// options object (ctx.options).
export async function setupV2(ctx: any, options?: SeeImageOptions) {
  const cfg = resolveConfig(options)
  const cwd: string = ctx?.location?.directory ?? process.cwd()

  // Best-effort and never awaited, so it can't hold up activation.
  autoUpdate({ pkgName: PKG_NAME, importMeta: import.meta, runtime: "v2" }).catch(() => {})

  // Vision capability of the model most recently used per session, consulted
  // in execute() to fail soft when a vision-capable model calls see_image.
  const sessionVision = new Map<string, boolean>()
  const rememberVision = (sessionID: string | undefined, vision: boolean) => {
    if (!sessionID) return
    if (sessionVision.size > 500) sessionVision.clear()
    sessionVision.set(sessionID, vision)
  }

  // v2 hands hooks the active model as a bare `{ id, providerID }` ref, so
  // capabilities come from ctx.model.list(), keyed like the ref (Model.Info.id,
  // not modelID, which is the provider-side API id). Cached and refreshed on
  // demand from the (async) context hook; no timer to clean up.
  let visionIndex = new Map<string, boolean>()
  let visionIndexAt = 0
  async function refreshVisionIndex() {
    try {
      const list = await ctx.model.list()
      const next = new Map<string, boolean>()
      for (const model of list?.data ?? list ?? []) {
        if (!model?.id) continue
        next.set(`${model.providerID}/${model.id}`, modelSupportsVision(model))
      }
      if (next.size) visionIndex = next
    } catch {
      // keep the previous index; fail open
    }
    visionIndexAt = Date.now()
  }
  async function supportsVision(ref: any): Promise<boolean> {
    if (!ref) return false
    const key = `${ref.providerID}/${ref.id}`
    if (!visionIndex.has(key) || Date.now() - visionIndexAt > VISION_INDEX_TTL_MS) {
      await refreshVisionIndex()
    }
    return visionIndex.get(key) ?? modelSupportsVision(ref)
  }

  // Helper sessions created for the vision call. v2 gives plugins no way to
  // delete a session, so IDs stay here for the plugin's lifetime; the tool
  // strip and permission deny below must keep covering a helper that is still
  // running after we gave up on it.
  const helperSessions = new Set<string>()
  const trackHelper = (sessionID: string) => {
    if (helperSessions.size > 500) helperSessions.delete(helperSessions.values().next().value!)
    helperSessions.add(sessionID)
  }

  // Defense in depth behind HELPER_PERMISSIONS: deny any permission check a
  // helper session still manages to raise.
  if (typeof ctx.permission?.hook === "function") {
    try {
      await ctx.permission.hook("evaluate", (input: any) => {
        if (helperSessions.has(input?.sessionID)) input.effect = "deny"
      })
    } catch {
      // older v2 builds may not expose the permission domain
    }
  }

  // Vision call through a throwaway, tool-less v2 helper session.
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
      if (abort?.aborted) break
      let sessionID: string | undefined
      try {
        const session = await ctx.session.create({
          title: "see_image helper",
          model: { id: modelID, providerID },
          permissions: HELPER_PERMISSIONS,
        })
        sessionID = session?.id ?? session?.data?.id
        if (!sessionID) {
          errors.push(`${providerID}/${modelID}: no session ID`)
          continue
        }
        const helperID: string = sessionID
        trackHelper(helperID)

        // Stop the helper on user abort or timeout, so it never keeps
        // generating after we've stopped listening.
        const interrupt = () => {
          Promise.resolve(ctx.session.interrupt?.({ sessionID: helperID })).catch(() => {})
        }
        abort?.addEventListener("abort", interrupt)
        let waitTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await ctx.session.prompt({
            sessionID: helperID,
            text: prompt,
            files: [{ uri: `data:${mediaType};base64,${b64}`, name: `see-image.${ext}` }],
          })
          const timedOut = new Promise<never>((_, reject) => {
            waitTimer = setTimeout(() => {
              interrupt()
              reject(new Error(`session.wait timed out after ${cfg.timeout}ms`))
            }, cfg.timeout)
            waitTimer.unref?.()
          })
          await Promise.race([ctx.session.wait({ sessionID: helperID }), timedOut])
        } finally {
          if (waitTimer) clearTimeout(waitTimer)
          abort?.removeEventListener("abort", interrupt)
        }

        const messages = await ctx.session.context({ sessionID: helperID })
        const text = extractAssistantText(messages)
        if (text) {
          result = { text, model: modelID, provider: providerID }
          break
        }
        // Provider failures (unknown model, usage limit, …) end the turn with
        // an error on the assistant message rather than rejecting prompt().
        const failure = (messages ?? []).findLast?.((m: any) => m?.type === "assistant" && m?.error)
        errors.push(
          `${providerID}/${modelID}: ${failure?.error?.message ?? "no text in response"}`,
        )
      } catch (e: any) {
        errors.push(`${providerID}/${modelID}: ${e?.message ?? e}`)
      }
    }

    if (!result && !abort?.aborted) {
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
        // v2 hides tools behind its code-mode `execute` wrapper unless they
        // opt out; the system prompt tells the model to call see_image
        // directly, so it must be a direct tool like the built-ins.
        options: { codemode: false },
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

  // Inject the see_image instructions for text-only models, keep the
  // per-session vision flag current, and strip tools from helper sessions.
  if (ctx.session?.hook) {
    await ctx.session.hook("context", async (input: any) => {
      // Tool-less helper sessions: second layer behind HELPER_PERMISSIONS.
      if (helperSessions.has(input?.sessionID)) {
        for (const name of Object.keys(input.tools ?? {})) delete input.tools[name]
        return
      }
      const vision = await supportsVision(input?.model)
      rememberVision(input?.sessionID, vision)
      if (vision) return
      input.system.push({ type: "text", text: SYSTEM_INSTRUCTIONS })
    })
  }
}
