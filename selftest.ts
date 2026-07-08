// Cross-platform smoke test for opencode-see-image image resolution.
// Run on any platform (especially Windows) to confirm the plugin can locate
// opencode's DB and pull an image out of it.
//
//   bun selftest.ts                 # resolve the most recent image in the DB
//   bun selftest.ts "Screenshot.png"  # resolve a specific bare filename
//
// It does NOT call the vision model — it only tests the parts that are
// platform-sensitive (DB path discovery + filesystem search).

import fs from "fs"
import {
  opencodeDataDirs,
  opencodeDbPath,
  screenshotSearchDirs,
  resolveImage,
} from "./lib.ts"

const target = process.argv[2] || "clipboard"
const cwd = process.cwd()

console.log("platform        :", process.platform)
console.log("home            :", process.env.HOME || process.env.USERPROFILE)
console.log()

console.log("data-dir candidates (probed in order):")
for (const dir of opencodeDataDirs()) {
  const db = `${dir}/opencode.db`.replace(/\//g, require("path").sep)
  console.log(`  ${fs.existsSync(db) ? "✓ has db" : "  no db "}  ${dir}`)
}
console.log()

const dbPath = opencodeDbPath()
console.log("chosen opencode.db :", dbPath)
console.log("db exists          :", fs.existsSync(dbPath))
console.log()

console.log("filesystem fallback search dirs:")
for (const dir of screenshotSearchDirs(cwd)) {
  console.log(`  ${fs.existsSync(dir) ? "✓" : " "}  ${dir}`)
}
console.log()

console.log(`resolving image: "${target}" ...`)
try {
  const r = await resolveImage(target, cwd)
  const bytes = Math.round(((r.dataUrl.split(",")[1] || "").length * 3) / 4)
  console.log("  ✓ RESOLVED")
  console.log("    source    :", r.source)
  console.log("    mediaType :", r.mediaType)
  console.log("    size      :", (bytes / 1024).toFixed(1), "KB")
} catch (e: any) {
  console.log("  ✗ FAILED:", e?.message ?? e)
}
