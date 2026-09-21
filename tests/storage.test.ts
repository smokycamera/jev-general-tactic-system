import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { CommandRuntime, MemoryPlanStore } from '@jev/core';
import { DemoAdapter, defaultCommanders } from '@jev/demo';
import { FilePlanStore } from '../apps/server/src/file-store.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'jev-store-'));
  dirs.push(dir);
  const runtime = new CommandRuntime({
    adapter: new DemoAdapter(),
    store: new MemoryPlanStore(),
    commanders: defaultCommanders(),
  });
  await runtime.step();
  const cp = await runtime.exportCheckpoint();
  return { dir, cp, store: new FilePlanStore(dir) };
}
describe('检查点持久化', () => {
  it('saves atomically, verifies checksums and rejects stale revisions', async () => {
    const { dir, cp, store } = await setup();
    cp.revision = 1;
    await store.save(cp, 0);
    expect(await store.load(cp.sessionId)).toEqual(cp);
    await expect(store.save({ ...cp, revision: 2 }, 0)).rejects.toThrow();
    const second = new FilePlanStore(dir);
    const competing = await Promise.allSettled([
      store.save({ ...cp, revision: 2 }, 1),
      second.save({ ...cp, revision: 2 }, 1),
    ]);
    expect(competing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('ignores an incomplete temporary write and loads the committed snapshot', async () => {
    const { dir, cp, store } = await setup();
    cp.revision = 1;
    await store.save(cp, 0);
    await writeFile(join(dir, `${cp.sessionId}.dead.tmp`), '{"partial":');
    expect(await store.load(cp.sessionId)).toEqual(cp);
  });
  it('detects corruption and never silently starts a fresh battle over it', async () => {
    const { dir, cp, store } = await setup();
    cp.revision = 1;
    await store.save(cp, 0);
    const path = join(dir, `${cp.sessionId}.json`);
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.checkpoint.plan.version = 999;
    await writeFile(path, JSON.stringify(data));
    await expect(store.load(cp.sessionId)).rejects.toThrow('checksum');
  });
  it('recovers a lock left by a dead process and protects live writers', async () => {
    const { dir, cp, store } = await setup();
    const lock = join(dir, `${cp.sessionId}.json.lock`);
    await mkdir(lock);
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 2147483647, host: hostname() }),
    );
    cp.revision = 1;
    await store.save(cp, 0);
    await mkdir(lock);
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname() }),
    );
    await expect(store.save({ ...cp, revision: 2 }, 1)).rejects.toThrow('another process');
  });
});
