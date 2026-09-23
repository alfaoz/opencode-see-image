// opencode-see-image — dual v1/v2 plugin entrypoint.
//
// Give non-vision opencode models the ability to see images by routing them to
// a vision-capable model.
//
// The two OpenCode runtimes use incompatible plugin shapes:
//   - v1 (`opencode` 1.x):        default export `{ id?, server }`
//   - v2 (`opencode2` 2.x beta):  default export `{ id, setup }` or `{ id, effect }`
//
// A module must satisfy both, so this file exports exactly one object carrying
// both a `server` member (v1) and a `setup` member (v2). Each loader validates
// only the members it understands:
//   - v2's loader decodes `{ id, setup }` (an extra `server` key is ignored),
//     then calls `setup(ctx)`.
//   - v1's loader detects the `{ id, server }` object and calls `server(ctx)`,
//     ignoring `setup`.
//
// IMPORTANT: this module must export *nothing* but the default. The v1 loader
// invokes every exported binding as if it were a plugin factory, so a stray
// helper export would crash the whole plugin at load time (helpers live in
// core.ts / lib.ts / v1.ts / v2.ts for exactly this reason).

import { createV1Hooks } from "./v1.ts"
import { setupV2 } from "./v2.ts"
import type { SeeImageOptions } from "./core.ts"

const SeeImagePlugin = {
  id: "opencode-see-image",

  // v2 entrypoint.
  setup: async (ctx: any) => {
    await setupV2(ctx, (ctx?.options ?? {}) as SeeImageOptions)
  },

  // v1 entrypoint.
  server: async (ctx: any, options?: SeeImageOptions) => {
    return createV1Hooks(ctx, options)
  },
}

export default SeeImagePlugin
