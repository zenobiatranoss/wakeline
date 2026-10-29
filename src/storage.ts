import * as fsp from "fs/promises";
import * as path from "path";

// recordings in global storage
export function recordings_dir(root: string) {
  return path.join(root, "recordings");
}

export async function ensure_dir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

// squish a qualified function name into something safe on every filesystem.
// the fallback matters for names that are all punctuation.
function safe_part(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "function";
}

// the timestamp is part of the name, so sorting by name is sorting by age and
// two runs can never collide.
export function new_recording_path(dir: string, language: string, name: string) {
  return path.join(dir, `${language}_${safe_part(name)}_${Date.now()}.jsonl`);
}

export async function prune(dir: string, retention: number) {
  // retention is per function, so one noisy function cannot delete another one's history
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const groups = new Map<string, { file: string; ms: number }[]>();
  for (const file of names) {
    const m = /^([a-z]+)_(.+)_(\d+)\.jsonl$/.exec(file);
    if (!m) continue;
    const key = `${m[1]}_${m[2]}`;
    const list = groups.get(key) ?? [];
    list.push({ file, ms: Number(m[3]) });
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.ms - a.ms);
    for (const old of list.slice(Math.max(1, retention))) {
      await fsp.rm(path.join(dir, old.file), { force: true });
    }
  }
}

// newest recording for one exact function, used by "open last recording" when
// the cursor is inside a function.
export async function latest_recording(dir: string, language: string, name: string) {
  const prefix = `${language}_${safe_part(name)}_`;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const hits = names
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .map((f) => ({ f, ms: Number(/_(\d+)\.jsonl$/.exec(f)?.[1] ?? 0) }))
    .sort((a, b) => b.ms - a.ms);
  return hits.length ? path.join(dir, hits[0].f) : null;
}

// fallback for "open last recording" when there is no function under the
// cursor. any recording in the folder wins.
export async function latest_any(dir: string) {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  let best: { file: string; ms: number } | null = null;
  for (const file of entries) {
    if (!file.endsWith(".jsonl")) continue;
    const ms = Number(/_(\d+)\.jsonl$/.exec(file)?.[1] ?? 0);
    if (!best || ms > best.ms) best = { file, ms };
  }
  return best ? path.join(dir, best.file) : null;
}

// delete and recreate in one go, so the folder is still there for the next
// run even if someone clears while the panel is open.
export async function clear_recordings(dir: string) {
  await fsp.rm(dir, { recursive: true, force: true });
  await ensure_dir(dir);
}
