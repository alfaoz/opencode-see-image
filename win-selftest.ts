// Simulated-Windows test for opencode-see-image, runnable from any OS.
//
// We can't boot Windows here, so we fake the parts of the environment the
// plugin actually branches on: process.platform, os.homedir(), and the
// %LOCALAPPDATA% / %TEMP% env vars. Then we build a throwaway opencode.db in
// the simulated %LOCALAPPDATA% (NOT in ~/.local/share — so a pass proves the
// new Windows data-dir candidate is what found it) and run the REAL resolver
// functions from index.ts against it.
//
//   bun win-selftest.ts

import fs from "fs"
import path from "path"
import os from "os"
import { Database } from "bun:sqlite"

// --- build the sandbox (real fs, before any override) -----------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "see-image-win-"))
const fakeHome = path.join(sandbox, "home")
const localAppData = path.join(sandbox, "AppData", "Local")
const appData = path.join(sandbox, "AppData", "Roaming")
const tempDir = path.join(sandbox, "Temp")
const dbDir = path.join(localAppData, "opencode")
const screenshotsDir = path.join(fakeHome, "Pictures", "Screenshots")

for (const d of [fakeHome, localAppData, appData, tempDir, dbDir, screenshotsDir])
  fs.mkdirSync(d, { recursive: true })

// 1x1 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

// DB with the schema the plugin queries.
const db = new Database(path.join(dbDir, "opencode.db"))
db.run(
  "CREATE TABLE part (session_id TEXT, data TEXT, time_created INTEGER)",
)
db.run("INSERT INTO part (session_id, data, time_created) VALUES (?, ?, ?)", [
  "sess-1",
  JSON.stringify({
    type: "file",
    filename: "pasted.png",
    mime: "image/png",
    url: `data:image/png;base64,${PNG_B64}`,
  }),
  Date.now(),
])
db.close()

// An image on disk that is NOT in the DB, to exercise the filesystem fallback.
fs.writeFileSync(
  path.join(screenshotsDir, "Screenshot 2026-06-22.png"),
  Buffer.from(PNG_B64, "base64"),
)

// --- put on the Windows costume ---------------------------------------------
Object.defineProperty(process, "platform", { value: "win32" })
os.homedir = () => fakeHome
delete process.env.OPENCODE_DATA_DIR
delete process.env.XDG_DATA_HOME
process.env.USERPROFILE = fakeHome
process.env.LOCALAPPDATA = localAppData
process.env.APPDATA = appData
process.env.TEMP = tempDir
process.env.TMP = tempDir

// Import the REAL code only after the environment is faked.
const { opencodeDataDirs, opencodeDbPath, screenshotSearchDirs, resolveImage } =
  await import("./index.ts")

// --- assertions -------------------------------------------------------------
let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`)
    pass++
  } else {
    console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`)
    fail++
  }
}

console.log("simulated platform :", process.platform)
console.log("simulated home     :", os.homedir())
console.log("simulated DB under :", dbDir, "(NOT ~/.local/share)\n")

const dirs = opencodeDataDirs()
check(
  "data-dir candidates include %LOCALAPPDATA%\\opencode",
  dirs.includes(path.join(localAppData, "opencode")),
  dirs.join(" | "),
)
check(
  "data-dir candidates include %APPDATA%\\opencode",
  dirs.includes(path.join(appData, "opencode")),
)

const chosen = opencodeDbPath()
check(
  "opencodeDbPath() finds the DB in %LOCALAPPDATA%",
  chosen === path.join(dbDir, "opencode.db"),
  chosen,
)

const search = screenshotSearchDirs(process.cwd())
check(
  "search dirs include ~\\Pictures\\Screenshots",
  search.includes(screenshotsDir),
)
check("search dirs include %TEMP%", search.includes(tempDir))
check(
  "search dirs DO NOT include macOS TemporaryItems",
  !search.some((d) => d.includes("TemporaryItems")),
)

try {
  const r = resolveImage("clipboard", process.cwd())
  check(
    "resolveImage('clipboard') pulls image from DB schema",
    r.source === "opencode-db" && r.dataUrl.startsWith("data:image/png"),
    `source=${r.source}`,
  )
} catch (e: any) {
  check("resolveImage('clipboard') pulls image from DB schema", false, e?.message)
}

try {
  const r = resolveImage("Screenshot 2026-06-22.png", process.cwd())
  check(
    "resolveImage(filename not in DB) falls back to Pictures\\Screenshots",
    r.source === path.join(screenshotsDir, "Screenshot 2026-06-22.png"),
    `source=${r.source}`,
  )
} catch (e: any) {
  check("resolveImage(filename) filesystem fallback", false, e?.message)
}

// --- cleanup ----------------------------------------------------------------
fs.rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
