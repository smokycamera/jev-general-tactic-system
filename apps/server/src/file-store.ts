import { mkdir, readFile, open, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { assert, SerialQueue, stable, validateCheckpoint } from '@jev/core';
import type { Checkpoint, PlanStore } from '@jev/core';
/** Filesystem CAS with an exclusive cross-process lock, fsync and same-directory rename. */
export class FilePlanStore implements PlanStore {
  private queue = new SerialQueue();
  constructor(readonly directory: string) {}
  private path(sessionId: string) {
    assert(/^[a-zA-Z0-9_.-]{1,100}$/.test(sessionId), 'invalid session id');
    return join(this.directory, `${sessionId}.json`);
  }
  private async acquire(lock: string): Promise<void> {
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Reclaim only a positively identified dead writer on this machine.
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as {
        pid: number;
        host: string;
      };
      assert(
        owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0,
        'checkpoint lock owner unknown',
      );
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
      }
      assert(dead, 'checkpoint is being written by another process');
      await unlink(join(lock, 'owner.json'));
      await rmdir(lock);
      await mkdir(lock);
    }
    const owner = await open(join(lock, 'owner.json'), 'wx', 0o600);
    try {
      await owner.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
      await owner.sync();
    } finally {
      await owner.close();
    }
  }
  async load(sessionId: string): Promise<Checkpoint | null> {
    try {
      const data = JSON.parse(await readFile(this.path(sessionId), 'utf8')) as {
        checksum: string;
        checkpoint: unknown;
      };
      validateCheckpoint(data.checkpoint);
      assert(
        data.checksum === createHash('sha256').update(stable(data.checkpoint)).digest('hex'),
        'checkpoint checksum mismatch',
      );
      assert(data.checkpoint.sessionId === sessionId, 'checkpoint session mismatch');
      return data.checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async save(checkpoint: Checkpoint, expectedRevision: number): Promise<void> {
    return this.queue.run(async () => {
      validateCheckpoint(checkpoint);
      assert(checkpoint.revision === expectedRevision + 1, 'invalid checkpoint revision');
      await mkdir(this.directory, { recursive: true });
      const path = this.path(checkpoint.sessionId),
        lock = `${path}.lock`,
        temp = `${path}.${randomUUID()}.tmp`;
      await this.acquire(lock);
      try {
        const existing = await this.load(checkpoint.sessionId);
        assert((existing?.revision ?? 0) === expectedRevision, 'checkpoint version conflict');
        const payload = JSON.stringify({
          checksum: createHash('sha256').update(stable(checkpoint)).digest('hex'),
          checkpoint,
        });
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(payload);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, path);
        if (process.platform !== 'win32') {
          const dir = await open(this.directory, 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }
      } finally {
        await unlink(temp).catch((e) => {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        });
        await unlink(join(lock, 'owner.json'));
        await rmdir(lock);
      }
    });
  }
}
