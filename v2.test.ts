import { expect, mock, test } from "bun:test"
import { SYSTEM_INSTRUCTIONS } from "./core.ts"

mock.module("opencode-plugin-update-kit", () => ({ autoUpdate: async () => {} }))
const { setupV2 } = await import("./v2.ts")

async function sessionHooks() {
  const hooks = new Map<string, (input: any) => Promise<void>>()
  await setupV2({
    location: { directory: process.cwd() },
    model: {
      list: async () => [
        { id: "glm", providerID: "zai", capabilities: { input: ["text"] } },
        { id: "claude", providerID: "anthropic", capabilities: { input: ["text", "image"] } },
      ],
    },
    tool: { transform: async () => {} },
    session: { hook: async (name: string, fn: any) => void hooks.set(name, fn) },
  })
  return hooks
}

const request = (id: string, providerID: string) => ({
  sessionID: "ses_1",
  model: { id, providerID },
  system: [] as any[],
  messages: [],
  tools: { read: { description: "read" }, see_image: { description: "see" } } as Record<string, unknown>,
})

test("vision models are not offered see_image", async () => {
  const hooks = await sessionHooks()
  for (const name of ["context", "compaction"]) {
    const input = request("claude", "anthropic")
    await hooks.get(name)!(input)
    expect(Object.keys(input.tools)).toEqual(["read"])
    expect(input.system).toEqual([])
  }
})

test("text-only models keep see_image and get its instructions", async () => {
  const hooks = await sessionHooks()
  const input = request("glm", "zai")
  await hooks.get("context")!(input)
  expect(Object.keys(input.tools)).toEqual(["read", "see_image"])
  expect(input.system).toEqual([{ type: "text", text: SYSTEM_INSTRUCTIONS }])

  const compaction = request("glm", "zai")
  await hooks.get("compaction")!(compaction)
  expect(Object.keys(compaction.tools)).toEqual(["read", "see_image"])
})
