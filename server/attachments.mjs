// Attachment bytes — one reader, one writer, one directory.
//
// routes/agent.mjs owns INTAKE (POST /api/agent/attach) and serves the files
// back over HTTP for transcript rendering. The kernel needs the SAME bytes at a
// different moment: a steered second look folds a screenshot the human sent
// while stage 1 was in flight into the vision prompt. Two copies of "how an id
// becomes an image part" would drift, and the drift would be invisible — the
// chat would show a picture the model never received. So both call this.
//
// Attachments live at a STABLE path (sessions/attachments, not the per-boot
// runDir) so a persisted transcript entry's image URL still resolves after a
// server restart — which is also why a screenshot sent during one boot can be
// read by a producer in the next.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const MAX_BYTES = 6 * 1024 * 1024;

export function attachmentsDir(repoRoot) {
  const dir = resolve(repoRoot, 'sessions', 'attachments');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The sidecar is the only record of what an id means: the file itself carries no
// media type, and a bare id in a transcript entry is opaque without it.
// `basename` is not paranoia about paths in general — it is about an id that
// arrives from a browser and is used to build a filename.
export function attachmentMeta(dir, id) {
  if (id == null) return null;
  const p = resolve(dir, `${basename(String(id))}.meta.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Resolve attachment ids into inline image parts — exactly the shape both
// agent.send() and buildVisionPrompt() want: [{ mediaType, dataBase64, name }].
// An id that has no sidecar, or whose bytes are gone, is SKIPPED rather than
// thrown on: a missing screenshot must not abort a producer that could still do
// its work from the words alone.
export function readImages(dir, ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const meta = attachmentMeta(dir, id);
    if (!meta) continue;
    const file = resolve(dir, basename(String(meta.file || '')));
    if (!existsSync(file)) continue;
    out.push({
      mediaType: meta.mediaType,
      dataBase64: readFileSync(file).toString('base64'),
      name: meta.name || null,
    });
  }
  return out;
}

// Intake. Returns { ok, attachmentId, url } or { ok:false, code, error } so the
// route maps one cause to one HTTP status without re-deriving the rules.
export function storeImage(dir, { mediaType, dataBase64, name } = {}) {
  if (!IMAGE_TYPES.has(mediaType)) return { ok: false, code: 400, error: `unsupported mediaType: ${mediaType}` };
  const bytes = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!bytes.length) return { ok: false, code: 400, error: 'empty image' };
  if (bytes.length > MAX_BYTES) return { ok: false, code: 413, error: `image too large (max ${MAX_BYTES >> 20}MB)` };
  const id = randomUUID();
  const file = `${id}.${EXT[mediaType]}`;
  writeFileSync(resolve(dir, file), bytes);
  writeFileSync(resolve(dir, `${id}.meta.json`), JSON.stringify({
    id, file, mediaType, name: name || null, bytes: bytes.length, ts: Date.now(),
  }, null, 2));
  return { ok: true, attachmentId: id, url: `/api/agent/attachments/${file}`, file };
}
