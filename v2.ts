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
import { EXT_MEDIA, declaredVision, modelSupportsVision, resolveImageV2 } from "./lib.ts"
import {
  createDescriptionCache,
  defaultCacheDir,
  findImages,
  mapImages,
  renderDescription,
  type FoundImage,
} from "./auto.ts"
import {
  AUTO_INSTRUCTIONS,
  DEFAULT_QUESTION,
  FILEPATH_DESCRIPTION,
  PKG_NAME,
  QUESTION_DESCRIPTION,
  SYSTEM_INSTRUCTIONS,
  TOOL_DESCRIPTION,
  heartbeatBar,
  httpFallbackKey,
  resolveConfig,
  seeImageViaHTTP,
  visionCandidates,
  type SeeImageOptions,
  type VisionResult,
} from "./core.ts"

const VISION_INDEX_TTL_MS = 30_000
// Auto mode: uncached images described at once. Higher values make a resumed
// session full of screenshots hit provider rate limits, and every helper
// session shows up in the user's session list.
const MAX_PARALLEL_DESCRIPTIONS = 3

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
  let visionIndex = new Map<string, boolean | undefined>()
  let visionIndexAt = 0
  async function refreshVisionIndex() {
    try {
      const list = await ctx.model.list()
      const next = new Map<string, boolean | undefined>()
      for (const model of list?.data ?? list ?? []) {
        if (!model?.id) continue
        next.set(`${model.providerID}/${model.id}`, declaredVision(model))
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
  // Auto mode rewrites the transcript, so it acts only on models the catalog
  // positively marks as text-only. A model missing from the index, or listed
  // without any input types, keeps its images and gets the tool flow instead.
  // Call after supportsVision(), which refreshes the index.
  const knownTextOnly = (ref: any) =>
    Boolean(ref) && visionIndex.get(`${ref.providerID}/${ref.id}`) === false

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

    for (const { providerID, modelID } of visionCandidates(cfg)) {
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
      const apiKey = cfg.apiKey || httpFallbackKey(cfg)
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

  const descriptions = cfg.auto
    ? createDescriptionCache({
        dir: defaultCacheDir(),
        route: JSON.stringify([
          DEFAULT_QUESTION,
          cfg.apiKey ? [cfg.endpoint, cfg.model] : visionCandidates(cfg),
        ]),
        timeoutMs: cfg.timeout,
      })
    : undefined

  function describe(image: FoundImage): Promise<VisionResult> {
    return descriptions!.describe(image.key, () =>
      cfg.apiKey
        ? seeImageViaHTTP(image.base64, image.mediaType, DEFAULT_QUESTION, cfg)
        : seeImageViaV2(
            `data:${image.mediaType};base64,${image.base64}`,
            image.mediaType,
            DEFAULT_QUESTION,
          ),
    )
  }

  // Swaps each image the vision model could describe for its description.
  // Images that fail stay in place, so OpenCode turns them into its usual
  // "unsupported input" error and the model can fall back to see_image.
  // The turn waits at most cfg.timeout. Images still being described then
  // finish in the background and are used from the cache on a later step.
  async function describeImagesInPlace(input: any) {
    if (!Array.isArray(input?.messages)) return
    const queue = findImages(input.messages)
    if (queue.length === 0) return
    const results = new Map<string, VisionResult>()
    const worker = async () => {
      for (let image = queue.shift(); image; image = queue.shift()) {
        try {
          results.set(image.key, await describe(image))
        } catch {
          // left in place; see above
        }
      }
    }
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_DESCRIPTIONS, queue.length) }, worker)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(workers),
      new Promise((resolve) => {
        timer = setTimeout(resolve, cfg.timeout)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    if (results.size === 0) return
    input.messages = mapImages(input.messages, (image) => {
      const result = results.get(image.key)
      return result && renderDescription(image, result)
    })
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

  // OpenCode treats a rejected session hook as a defect that ends the turn, so
  // a surprise while rewriting the request falls back to the see_image flow.
  const describeImages = (input: any) => describeImagesInPlace(input).catch(() => {})

  // Requests outside the main turn (compaction, generate) carry the tool list
  // and the conversation too, so they get the same treatment.
  //
  // Vision models see images directly, so they are not offered see_image:
  // its definition would cost every request ~550 tokens for nothing. OpenCode's
  // own patch plugin drops tools per model the same way, and earlier see_image
  // calls stay readable in the history after a model switch.
  async function shapeSideRequest(input: any) {
    if (helperSessions.has(input?.sessionID)) return
    if (await supportsVision(input?.model)) delete input.tools?.see_image
    else if (descriptions && knownTextOnly(input?.model)) await describeImages(input)
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
      if (vision) {
        delete input.tools?.see_image
        return
      }
      if (descriptions && knownTextOnly(input?.model)) {
        await describeImages(input)
        input.system.push({ type: "text", text: AUTO_INSTRUCTIONS })
        return
      }
      input.system.push({ type: "text", text: SYSTEM_INSTRUCTIONS })
    })

    for (const name of ["compaction", "generate"]) {
      try {
        await ctx.session.hook(name, shapeSideRequest)
      } catch {
        // builds without this hook keep OpenCode's default
      }
    }
  }
}
