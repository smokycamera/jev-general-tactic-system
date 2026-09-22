import { it, expect } from 'vitest';
import { createService } from '../apps/server/src/app.js';
import { createObservation, defaultCommanders } from '@jev/demo';
import type { AddressInfo } from 'node:net';

it('model bridge authenticates, validates bindings and never executes host actions', async () => {
  let calls = 0;
  const service = createService({
    token: 'local-test',
    allowedOrigins: ['http://localhost:8000'],
    provider: {
      id: 'test',
      evaluate: async (r) => {
        calls++;
        return {
          model: 'test',
          confidence: 1,
          scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.5])),
        };
      },
    },
  });
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/api/bridge/evaluate`;
  const observation = createObservation();
  const body = {
    id: 'test',
    sessionId: observation.sessionId,
    stateVersion: observation.version,
    planVersion: 0,
    purpose: 'doctrine',
    observation,
    commander: defaultCommanders()[0],
    candidates: [{ id: 'a', label: 'a', total: 1 }],
  };
  try {
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer local-test',
      Origin: 'http://localhost:8000',
    };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect((await response.json()).model).toBe('test');
    expect(calls).toBe(1);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, stateVersion: 999 }),
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(1);
    expect(
      (
        await fetch(url, {
          method: 'OPTIONS',
          headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST' },
        })
      ).status,
    ).toBe(204);
  } finally {
    await service.close();
  }
});
