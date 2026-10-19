/** Non-destructive, resumable import of pre-rename application data. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeTextFileAtomic } from "../../config/atomicFile.js";

const STATE_DIRECTORY = ".identity-migration";

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ensureDirectory(path: string): void {
  if (dirname(path) !== path) ensureDirectory(dirname(path));
  if (!exists(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error("Unsafe migration destination.");
  }
}

function validateFile(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error("Unsupported migration entry.");
  if (path.endsWith(".json")) JSON.parse(readFileSync(path, "utf8"));
  if (path.endsWith(".jsonl")) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim()) JSON.parse(line);
    }
  }
}

function transient(name: string): boolean {
  return name === STATE_DIRECTORY || /(?:\.lock|\.tmp|\.sock|\.pid)$/.test(name);
}

/** Stages a complete legacy conversation so generations are never combined. */
function stageRecord(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (transient(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Unsupported migration symlink.");
    if (entry.isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      stageRecord(from, to);
    } else {
      validateFile(from);
      copyFileSync(from, to);
      chmodSync(to, 0o600);
    }
  }
}

/**
 * Imports missing artifacts, retaining originals and current files. A per-source receipt
 * prevents completed imports from resurrecting deleted data. Failed imports remain retryable.
 * No source content or credentials are logged. Returns false on incomplete migration.
 */
export function importLegacyData(source: string, destination: string): boolean {
  const from = resolve(source);
  const to = resolve(destination);
  if (from === to || !existsSync(from)) return true;
  const overlaps = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
  };
  if (overlaps(from, to) || overlaps(to, from)) return false;
  let lock: string | undefined;
  try {
    if (!lstatSync(from).isDirectory() || lstatSync(from).isSymbolicLink()) return false;
    ensureDirectory(to);
    const state = join(to, STATE_DIRECTORY);
    ensureDirectory(state);
    const key = createHash("sha256").update(from).digest("hex");
    const receipt = join(state, `${key}.json`);
    const lockPath = join(state, `${key}.lock`);
    if (exists(lockPath)) {
      if (!lstatSync(lockPath).isFile()) return false;
      const pid = Number(readFileSync(lockPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
      rmSync(lockPath);
    }
    writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    lock = lockPath;
    const saved = exists(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : {};
    const completed = new Set<string>(
      Array.isArray(saved.completed)
        ? saved.completed.filter((v: unknown) => typeof v === "string")
        : [],
    );
    if (saved.done === true) return true;
    let successful = true;
    const remember = (path: string) => {
      completed.add(path);
      writeTextFileAtomic(receipt, JSON.stringify({ completed: [...completed], done: false }));
      chmodSync(receipt, 0o600);
    };
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (transient(entry.name)) continue;
        const path = join(dir, entry.name);
        const rel = relative(from, path);
        if (completed.has(rel)) continue;
        const target = join(to, rel);
        try {
          if (entry.isSymbolicLink()) throw new Error("Unsupported migration symlink.");
          if (entry.isDirectory() && !/^chat_[A-Za-z0-9-]+$/.test(entry.name)) {
            ensureDirectory(target);
            walk(path);
            continue;
          }
          ensureDirectory(dirname(target));
          if (exists(target)) {
            remember(rel);
            continue;
          }
          const staged = mkdtempSync(join(dirname(target), ".ubume-import-"));
          try {
            if (entry.isDirectory()) {
              stageRecord(path, staged);
              // A concurrently populated record makes rename fail; it is never merged.
              if (!exists(target)) renameSync(staged, target);
            } else {
              validateFile(path);
              const file = join(staged, "content");
              copyFileSync(path, file);
              chmodSync(file, 0o600);
              try {
                linkSync(file, target); // Atomic publication that cannot replace a current file.
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              }
            }
            remember(rel);
          } finally {
            rmSync(staged, { recursive: true, force: true });
          }
        } catch {
          successful = false;
        }
      }
    };
    walk(from);
    if (successful) {
      writeTextFileAtomic(receipt, JSON.stringify({ completed: [...completed], done: true }));
      chmodSync(receipt, 0o600);
    }
    return successful;
  } catch {
    return false;
  } finally {
    try {
      if (lock) rmSync(lock, { force: true });
    } catch {
      // A retained lock is recoverable after this process exits.
    }
  }
}
