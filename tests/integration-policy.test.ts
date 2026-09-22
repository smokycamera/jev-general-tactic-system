import { describe, it, expect } from 'vitest';
import {
  CommandRuntime,
  MemoryPlanStore,
  narrativeWindow,
  validateNarrativeContext,
} from '@jev/core';
import { DemoAdapter, defaultCommanders, createObservation } from '@jev/demo';
import type { DecisionProvider } from '@jev/core';

describe('integration policy', () => {
  it('each side consults the provider on its own first activation', async () => {
    const sides: string[] = [];
    const provider: DecisionProvider = {
      id: 'test',
      evaluate: async (r) => {
        sides.push(r.commander.side);
        return {
          model: 'test',
          confidence: 1,
          scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.5])),
        };
      },
    };
    const adapter = new DemoAdapter();
    const commanders = defaultCommanders().filter((c) => c.id !== 'blue-wing');
    commanders[0]!.unitIds.push('b3');
    const runtime = new CommandRuntime({
      adapter,
      provider,
      store: new MemoryPlanStore(),
      commanders,
    });
    await runtime.step();
    expect(sides).toEqual(['blue']);
    expect(
      runtime.state.plan.tasks.filter((t) => t.level === 'tactics').map((t) => t.side),
    ).toEqual(['blue']);
    adapter.inject({ id: 'red-turn', kind: 'turn' }, (o) => {
      o.activeSide = 'red';
    });
    await runtime.step();
    expect(sides).toEqual(['blue', 'red']);
  });
  it('zero narrative window is empty and model calls have an absolute cap', () => {
    expect(
      narrativeWindow([{ id: '1', role: 'assistant', completed: true, text: 'secret' }], 0),
    ).toEqual([]);
    const runtime = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      policy: { maxModelCallsPerDecision: 999 },
    });
    expect(runtime.policy.maxModelCallsPerDecision).toBe(10);
  });
  it('manual-only scans preserve context hints without altering host facts', async () => {
    let scans = 0;
    const adapter = new DemoAdapter();
    const runtime = new CommandRuntime({
      adapter,
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      policy: {
        narrativeContext: {
          windowSize: 6,
          roles: ['assistant'],
          trigger: ['manual'],
          mode: 'manual',
        },
      },
      narrative: {
        recent: async () => [{ id: 'm', role: 'assistant', text: '夜间围城', completed: true }],
      },
      extractor: {
        extract: async () => {
          scans++;
          return { goals: [], battleType: 'siege', environment: ['night'] };
        },
      },
    });
    await runtime.step();
    expect(scans).toBe(0);
    const before = await adapter.snapshot();
    await runtime.scanNarrative();
    expect(scans).toBe(1);
    expect(await adapter.snapshot()).toEqual(before);
    expect((await runtime.exportCheckpoint()).narrativeContext?.battleType).toBe('siege');
  });
  it('narrative hints cannot introduce a foreign side', async () => {
    expect(() =>
      validateNarrativeContext(
        {
          goals: [
            {
              id: 'x',
              title: 'x',
              kind: 'eliminate',
              side: 'foreign',
              source: 'narrative',
              priority: 1,
              version: 0,
            },
          ],
        },
        createObservation(),
      ),
    ).toThrow('unknown goal side');
  });
});
