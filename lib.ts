// Image resolution for opencode-see-image.
//
// Kept separate from index.ts on purpose: opencode's plugin loader calls every
// function exported by the plugin entry module as if it were a plugin factory,
// so the entry file must export nothing but the plugin itself. Helpers and
// selftests import from here instead.
//
// Runtime note: the opencode desktop app runs the server on Node (inside an
// Electron utility process), while the CLI runs on Bun. Everything here must
// work on both, so sqlite access goes through a small adapter and the primary
// lookup path uses the opencode SDK client (plain HTTP) instead of the DB.

import path from "path"
import os from "os"
import fs from "fs"

export const EXT_MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
}

export type ResolvedImage = {
  dataUrl: string
  mediaType: string
  source: string
}

type ImagePart = {
  filename?: string
  mime?: string
  url: string
}

// Candidate opencode data directories, in priority order. opencode itself uses
// xdg-basedir, which falls back to ~/.local/share/opencode when XDG_DATA_HOME is
// unset (the norm on Windows) — but some setups put it under native app dirs, so
// we probe several and let the caller pick whichever actually has the file.
export function opencodeDataDirs(): string[] {
  const dirs: string[] = []
  if (process.env.OPENCODE_DATA_DIR) dirs.push(process.env.OPENCODE_DATA_DIR)
  if (process.env.XDG_DATA_HOME)
    dirs.push(path.join(process.env.XDG_DATA_HOME, "opencode"))
  dirs.push(path.join(os.homedir(), ".local/share/opencode"))
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA)
      dirs.push(path.join(process.env.LOCALAPPDATA, "opencode"))
    if (process.env.APPDATA)
      dirs.push(path.join(process.env.APPDATA, "opencode"))
  }
  return dirs
}

export function opencodeDbPath(): string {
  const dirs = opencodeDataDirs()
  for (const dir of dirs) {
    const p = path.join(dir, "opencode.db")
    if (fs.existsSync(p)) return p
  }
  return path.join(dirs[dirs.length - 1], "opencode.db")
}

// ── sqlite adapter (Bun or Node) ────────────────────────────────────

type DbHandle = {
  all: (sql: string, params: unknown[]) => any[]
  close: () => void
}

async function openDb(dbPath: string): Promise<DbHandle | null> {
  if (typeof Bun !== "undefined") {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(dbPath, { readonly: true })
      return {
        all: (sql, params) => db.query(sql).all(...(params as any[])) as any[],
        close: () => db.close(),
      }
    } catch {}
  }
  try {
    // Node 22.5+ (covers the Electron the desktop app ships).
    const sqlite = await import("node:sqlite")
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    return {
      all: (sql, params) => db.prepare(sql).all(...(params as any[])) as any[],
      close: () => db.close(),
    }
  } catch {}
  return null
}

// ── model capability detection ──────────────────────────────────────

// Whether the active model can view images natively. Vision-capable models
// receive attachments directly, so the see_image bridge is unnecessary there
// (and the image parts get consumed before the tool could find them).
// The model shape varies across opencode versions, so probe newest-first:
//   - capabilities.input.image  (current Model type)
//   - modalities.input          (models.dev style: ["text", "image"])
//   - capabilities.attachment / attachment  (older shapes; attachment support
//     has always meant image input in opencode)
export function modelSupportsVision(model: any): boolean {
  if (!model) return false
  const input = model.capabilities?.input
  if (input && typeof input.image === "boolean") return input.image
  const modalities = model.modalities?.input
  if (Array.isArray(modalities)) return modalities.includes("image")
  if (typeof model.capabilities?.attachment === "boolean")
    return model.capabilities.attachment
  if (typeof model.attachment === "boolean") return model.attachment
  return false
}

// ── image part matching ─────────────────────────────────────────────

function isImagePart(p: any): p is ImagePart {
  return (
    p &&
    p.type === "file" &&
    typeof p.url === "string" &&
    p.url.startsWith("data:") &&
    typeof p.mime === "string" &&
    p.mime.startsWith("image/")
  )
}

// Filenames get retyped by the model from error messages, so exact equality is
// too strict: macOS screenshot names contain a narrow no-break space (U+202F)
// that models normalize to a plain space, paths may be passed instead of bare
// names, etc.
export function normalizeName(name: string): string {
  return path
    .basename(name.trim())
    .normalize("NFKC")
    .replace(/[\u202f\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

function wantsLatest(name: string): boolean {
  return !name || name === "clipboard" || name === "latest"
}

// `parts` is chronological; prefer the most recent match.
function pickImage(parts: ImagePart[], name: string): ImagePart | null {
  if (wantsLatest(name)) {
    return parts.length ? parts[parts.length - 1] : null
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].filename === name) return parts[i]
  }
  const want = normalizeName(name)
  for (let i = parts.length - 1; i >= 0; i--) {
    const have = parts[i].filename
    if (have && normalizeName(have) === want) return parts[i]
  }
  return null
}

function toResolved(part: ImagePart, source: string): ResolvedImage {
  return {
    dataUrl: part.url,
    mediaType: part.mime || "image/png",
    source,
  }
}

// ── sources ─────────────────────────────────────────────────────────

// Primary: ask the opencode server for the session's messages. Works on every
// runtime and client (CLI, desktop app, remote workspaces) and always reflects
// whatever storage backend the server actually uses.
async function sessionImagePartsViaSDK(
  client: any,
  sessionID: string,
): Promise<ImagePart[]> {
  try {
    const res = await client.session.messages({ path: { id: sessionID } })
    const messages = res?.data ?? []
    const parts: ImagePart[] = []
    for (const message of messages) {
      for (const part of message?.parts ?? []) {
        if (isImagePart(part)) parts.push(part)
      }
    }
    return parts
  } catch {
    return []
  }
}

// Fallback: read opencode.db directly. Needed when no client/session is
// available (selftests) and for cross-session lookups.
async function imagePartsViaDb(
  sessionID?: string,
  limit = 400,
): Promise<ImagePart[]> {
  const dbPath = opencodeDbPath()
  if (!fs.existsSync(dbPath)) return []
  const db = await openDb(dbPath)
  if (!db) return []
  try {
    const sessionClause = sessionID ? "session_id = ? AND" : ""
    const rows = db.all(
      `SELECT data FROM part
       WHERE ${sessionClause}
         json_extract(data, '$.type') = 'file'
         AND json_extract(data, '$.url') LIKE 'data:image/%'
       ORDER BY time_created DESC
       LIMIT ?`,
      sessionID ? [sessionID, limit] : [limit],
    ) as Array<{ data: string }>
    const parts: ImagePart[] = []
    for (const row of rows) {
      try {
        const part = JSON.parse(row.data)
        if (isImagePart(part)) parts.push(part)
      } catch {}
    }
    return parts.reverse() // back to chronological order
  } catch {
    return []
  } finally {
    db.close()
  }
}

// Where a bare screenshot filename might live, per platform. This is the
// fallback for files not yet attached to the conversation (e.g. a screenshot
// just saved to disk).
export function screenshotSearchDirs(cwd: string): string[] {
  const home = os.homedir()
  const dirs: string[] = []

  if (process.platform === "win32") {
    // Win+PrtScn and Snipping Tool save here (plus the OneDrive-redirected
    // variant), and dragged/temp images land in %TEMP%.
    if (process.env.TEMP) dirs.push(process.env.TEMP)
    if (process.env.TMP && process.env.TMP !== process.env.TEMP)
      dirs.push(process.env.TMP)
    dirs.push(path.join(home, "Pictures", "Screenshots"))
    dirs.push(path.join(home, "OneDrive", "Pictures", "Screenshots"))
    dirs.push(path.join(home, "Pictures"))
  } else if (process.platform === "darwin") {
    const tmpdir = process.env.TMPDIR || "/tmp"
    const tempItems = path.join(tmpdir, "TemporaryItems")
    if (fs.existsSync(tempItems)) {
      try {
        for (const sub of fs.readdirSync(tempItems, { withFileTypes: true })) {
          if (sub.isDirectory() && sub.name.startsWith("NSIRD_screencaptureui")) {
            dirs.push(path.join(tempItems, sub.name))
          }
        }
      } catch {}
    }
    dirs.push(tempItems)
  } else {
    // Linux: GNOME/KDE screenshot tools default to ~/Pictures/Screenshots.
    if (process.env.TMPDIR) dirs.push(process.env.TMPDIR)
    dirs.push("/tmp")
    dirs.push(path.join(home, "Pictures", "Screenshots"))
    dirs.push(path.join(home, "Pictures"))
  }

  dirs.push(path.join(home, "Desktop"))
  dirs.push(path.join(home, "Downloads"))
  dirs.push(cwd)
  return dirs
}

export function resolveFromFilesystem(
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
    const searchDirs = screenshotSearchDirs(cwd)

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

// ── orchestrator ────────────────────────────────────────────────────
//
// Resolution ladder:
//   1. current session via SDK — exact filename, then normalized, then
//      (for empty/"clipboard"/"latest") the most recent image
//   2. same ladder against opencode.db directly
//   3. named files only: any session in opencode.db
//   4. named files only: filesystem search
//   5. named files only: most recent image in the session anyway — the user
//      attached *something*; describing it beats erroring out
export async function resolveImage(
  name: string,
  cwd: string,
  sessionID?: string,
  client?: any,
): Promise<ResolvedImage> {
  const latestOnly = wantsLatest(name)

  let sessionParts: ImagePart[] = []
  if (client && sessionID) {
    sessionParts = await sessionImagePartsViaSDK(client, sessionID)
    const hit = pickImage(sessionParts, name)
    if (hit) return toResolved(hit, "opencode-session")
  }

  const dbParts = await imagePartsViaDb(sessionID)
  {
    const hit = pickImage(dbParts, name)
    if (hit) return toResolved(hit, "opencode-db")
  }

  if (!latestOnly && sessionID) {
    const globalParts = await imagePartsViaDb(undefined)
    const hit = pickImage(globalParts, name)
    if (hit) return toResolved(hit, "opencode-db")
  }

  if (!latestOnly) {
    const fromFs = resolveFromFilesystem(name, cwd)
    if (fromFs) return fromFs
  }

  if (!latestOnly && sessionID) {
    const inSession = sessionParts.length ? sessionParts : dbParts
    const latest = pickImage(inSession, "")
    if (latest) return toResolved(latest, "opencode-session-latest")
  }

  const known = [
    ...new Set(
      [...sessionParts, ...dbParts]
        .map((p) => p.filename)
        .filter((f): f is string => !!f),
    ),
  ].slice(-5)
  throw new Error(
    `see_image: could not find "${name || "any attached image"}". ` +
      (known.length
        ? `Images attached to this session: ${known
            .map((f) => `"${f}"`)
            .join(", ")}. Call see_image again with one of those filenames.`
        : `No images found in this conversation. Ask the user to re-attach the image or provide an absolute file path.`),
  )
}
