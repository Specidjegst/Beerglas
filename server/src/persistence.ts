/**
 * Minimal JSON file store with atomic writes (write tmp file, then rename).
 * Writes are serialized through an internal promise chain so concurrent
 * save() calls can never interleave.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStore<T> {
  private queue: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(private readonly filePath: string) {}

  async load(fallback: T): Promise<T> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return fallback;
      throw err;
    }
  }

  /** Atomic, serialized save. The snapshot is taken synchronously at call time. */
  save(data: T): Promise<void> {
    const payload = JSON.stringify(data, null, 2);
    const next = this.queue.then(async () => {
      if (!this.dirReady) {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        this.dirReady = true;
      }
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, this.filePath);
    });
    // Keep the chain alive even if a write fails; the caller still sees the error.
    this.queue = next.catch(() => undefined);
    return next;
  }
}
