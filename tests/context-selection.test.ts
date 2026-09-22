import { it, expect } from 'vitest';
import { JevProvider } from '@jev/providers';
import { validateContextSelectionAnswer, type ContextSelectionRequest } from '@jev/core';
import { createService } from '../apps/server/src/app.js';
import type { AddressInfo } from 'node:net';

it('batches host-defined context choices through authenticated HTTP and the SDK, rejecting invalid choices', async () => {
  let calls = 0;
  const selector = new JevProvider({
    apiKey: 'test-only',
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.questions)).toEqual(['ability', 'terrain']);
      expect(JSON.parse(body.state).messages[0].text).toBe(
        'A veteran commands the defenders in the woods.',
      );
      return new Response(
        JSON.stringify({
          model: 'mock-jev',
          answers: Object.fromEntries(
            Object.entries(body.questions).map(([id, q]) => {
              const labels = Object.keys((q as { criteria: object }).criteria),
                value = labels.at(-1)!;
              return [
                id,
                {
                  type: 'choice',
                  choice: value,
                  confidence: 0.9,
                  probabilities: Object.fromEntries(labels.map((l) => [l, l === value ? 1 : 0])),
                },
              ];
            }),
          ),
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const request: ContextSelectionRequest = {
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        completed: true,
        text: 'A veteran commands the defenders in the woods.',
      },
    ],
    state: { phase: 'setup' },
    fields: [
      {
        id: 'ability',
        question: 'Command experience?',
        options: { unknown: 'unknown', expert: 'expert' },
      },
      {
        id: 'terrain',
        question: 'Environment?',
        options: { unknown: 'unknown', forest: 'forest' },
      },
    ],
  };
  const original = JSON.stringify(request),
    service = createService({ selector, token: 'local-test' });
  await new Promise<void>((r) => service.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/api/bridge/select-context`;
  try {
    expect((await fetch(url, { method: 'POST', body: original })).status).toBe(401);
    const headers = { Authorization: 'Bearer local-test', 'Content-Type': 'application/json' };
    const response = await fetch(url, { method: 'POST', headers, body: original });
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer.selections.ability.value).toBe('expert');
    expect(answer.selections.terrain.value).toBe('forest');
    expect(calls).toBe(1);
    expect(JSON.stringify(request)).toBe(original);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...request,
            fields: [{ ...request.fields[0], options: { only: 'one' } }],
          }),
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(1);
    expect(() =>
      validateContextSelectionAnswer(
        {
          ...answer,
          selections: { ...answer.selections, ability: { value: 'invented', confidence: 1 } },
        },
        request,
      ),
    ).toThrow();
  } finally {
    await service.close();
  }
});
