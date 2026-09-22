import { describe, expect, it } from 'vitest';
import { CommandRuntime, MemoryPlanStore } from '@jev/core';
import type { DecisionProvider } from '@jev/core';
import { DemoAdapter, defaultCommanders } from '@jev/demo';
import { JevProvider, ReplayProvider, ChatTextExtractor } from '@jev/providers';
const policy = { tickDelayMs: 0, requestTimeoutMs: 200, decisionBudgetMs: 1000 };
describe('官方 SDK 与模型回放', () => {
  it('batches benefit and risk questions through the real SDK transport', async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = new JevProvider({
      apiKey: 'test-only',
      fetch: async (url, init) => {
        expect(url).toContain('/v1/systemone');
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        const answers = Object.fromEntries(
          Object.entries(body.questions as Record<string, { type: string }>).map(([id, q]) => [
            id,
            q.type === 'score'
              ? {
                  type: 'score',
                  score: 2,
                  confidence: 0.8,
                  legend: { '0': 'none', '1': 'low', '2': 'good', '3': 'high' },
                  probabilities: { '0': 0, '1': 0, '2': 1, '3': 0 },
                }
              : { type: 'noul', noul: 0.2 },
          ]),
        );
        return new Response(
          JSON.stringify({
            model: 'mock-jev',
            answers,
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const runtime = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      provider,
      policy,
    });
    await runtime.step();
    expect(runtime.state.metrics.actions).toBe(1);
    expect(runtime.state.metrics.fallbacks).toBe(0);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(Object.keys(call.questions as object).length).toBeGreaterThanOrEqual(4);
      const state = JSON.parse(String(call.state));
      expect(Array.isArray(state.recentActions)).toBe(true);
      if (state.purpose === 'doctrine')
        expect(state.candidates.every((c: { steps: unknown[] }) => c.steps.length > 0)).toBe(true);
      expect(
        state.candidates.every(
          (c: Record<string, unknown>) => !('total' in c) && !('utility' in c),
        ),
      ).toBe(true);
    }
    expect(runtime.state.records[0]?.answer?.model).toBe('mock-jev');
    expect(JSON.stringify(runtime.state)).not.toContain('test-only');
  });
  it('replays recorded answers with identical actions and no network', async () => {
    const provider: DecisionProvider = {
      id: 'mock',
      evaluate: async (r) => ({
        scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.7])),
        confidence: 0.75,
        model: 'recorded-model',
      }),
    };
    const a = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      provider,
      policy,
    });
    for (let i = 0; i < 12; i++) await a.step();
    const replay = new ReplayProvider(a.state.records);
    const b = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      provider: replay,
      policy,
    });
    for (let i = 0; i < 12; i++) await b.step();
    expect(b.state.receipts).toEqual(a.state.receipts);
    expect(b.state.metrics.fallbacks).toBe(0);
    expect(replay.consumed).toBe(a.state.records.length);
  });
  it('invalid narrative cannot override user goals or mutate host facts', async () => {
    const extractor = new ChatTextExtractor({
      url: 'https://example.invalid/chat',
      apiKey: 'test',
      model: 'mock',
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    goals: [
                      {
                        id: 'mission',
                        side: 'blue',
                        title: '无效地点',
                        kind: 'capture',
                        target: 'not-in-map',
                        priority: 100,
                        source: 'user',
                        version: 99,
                      },
                    ],
                    units: [],
                  }),
                },
              },
            ],
          }),
        ),
    });
    const host = new DemoAdapter();
    const initial = await host.observe();
    await expect(
      extractor.extract(
        [{ id: 'm', role: 'assistant', text: '占领未知地点', completed: true }],
        initial,
        new AbortController().signal,
      ),
    ).rejects.toThrow('location');
    expect(await host.observe()).toEqual(initial);
  });
});
