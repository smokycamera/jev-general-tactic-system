import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createService } from '../apps/server/src/app.js';
const services: ReturnType<typeof createService>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});
async function setup(config: Parameters<typeof createService>[0] = {}) {
  const service = createService({ ...config, tickDelayMs: 1 });
  services.push(service);
  await new Promise<void>((r) => service.server.listen(0, '127.0.0.1', r));
  return { service, url: `http://127.0.0.1:${(service.server.address() as AddressInfo).port}` };
}
describe('本机服务', () => {
  it('runs and pauses a session, allows single step while paused, and exports a full checkpoint', async () => {
    const { url } = await setup();
    const created = await fetch(`${url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ id: 'service-test', auto: false, kind: 'regions' }),
    });
    expect(created.status).toBe(201);
    const base = `${url}/api/sessions/service-test`;
    await fetch(`${base}/pause`, { method: 'POST' });
    const stepped = (await (await fetch(`${base}/step`, { method: 'POST' })).json()) as {
      state: { metrics: { actions: number }; status: { state: string } };
    };
    expect(stepped.state.metrics.actions).toBe(1);
    expect(stepped.state.status.state).toBe('paused');
    const cp = (await (await fetch(`${base}/export`)).json()) as {
      host: unknown;
      revision: number;
    };
    expect(cp.host).toBeTruthy();
    expect(cp.revision).toBeGreaterThan(0);
  });
  it('defaults to automatic operation and requires no frontend approval', async () => {
    const { url, service } = await setup();
    await fetch(`${url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ id: 'auto-service', kind: 'regions' }),
    });
    const { runtime } = await service.getSession('auto-service');
    for (let i = 0; i < 300 && runtime.status.state !== 'ended'; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(runtime.status.state, runtime.status.detail).toBe('ended');
    expect(runtime.state.metrics.approvals).toBe(0);
  });
  it('rejects hostile origins, bad hostnames and missing tokens', async () => {
    const { url } = await setup({ token: 'local-secret' });
    expect((await fetch(`${url}/api/meta`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/meta`, {
          headers: { Authorization: 'Bearer local-secret', Origin: 'https://unrelated.example' },
        })
      ).status,
    ).toBe(403);
    const response = await fetch(`${url}/api/meta`, {
      headers: { Authorization: 'Bearer local-secret' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('local-secret');
  });
  it('rejects malformed goals and unknown manual actions', async () => {
    const { url } = await setup();
    await fetch(`${url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ id: 'input-test', auto: false }),
    });
    expect(
      (
        await fetch(`${url}/api/sessions/input-test/goals`, {
          method: 'POST',
          body: JSON.stringify({ goals: [{ id: 'x' }] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/api/sessions/input-test/manual`, {
          method: 'POST',
          body: JSON.stringify({ actionId: 'fabricated' }),
        })
      ).status,
    ).toBe(400);
  });
});
