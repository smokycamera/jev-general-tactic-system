import { describe, expect, it } from 'vitest';
import {
  CommandRuntime,
  DEFAULT_STYLE,
  MemoryPlanStore,
  PROFILES,
  Registry,
  Workflow,
  applyPlanPatch,
  clone,
  defaultDoctrines,
  defaultStyles,
  mergeGoals,
  narrativeWindow,
} from '@jev/core';
import type {
  Checkpoint,
  DecisionAnswer,
  DecisionProvider,
  DecisionStage,
  Goal,
  PlanStore,
} from '@jev/core';
import { DemoAdapter, createObservation, defaultCommanders } from '@jev/demo';
const policy = {
  tickDelayMs: 0,
  modelActionMode: 'model' as const,
  requestTimeoutMs: 10,
  decisionBudgetMs: 200,
  failureThreshold: 2,
  cooldownMs: 30,
  retries: 1,
  retryDelayMs: 1,
};
const make = (provider?: DecisionProvider) => {
  const adapter = new DemoAdapter();
  const store = new MemoryPlanStore();
  const runtime = new CommandRuntime({
    adapter,
    store,
    commanders: defaultCommanders(),
    policy,
    ...(provider ? { provider } : {}),
  });
  return { adapter, store, runtime };
};
describe('静默指挥与恢复', () => {
  it.each(['grid', 'regions'])(
    '%s completes a full battle with zero confirmations',
    async (kind) => {
      const adapter = new DemoAdapter(createObservation(kind));
      const runtime = new CommandRuntime({
        adapter,
        store: new MemoryPlanStore(),
        commanders: defaultCommanders(),
        policy,
      });
      await runtime.start(1000);
      expect(runtime.status.state, runtime.status.detail).toBe('ended');
      expect((await adapter.observe()).ended).toBe(true);
      expect(runtime.state.metrics.actions).toBeGreaterThan(5);
      expect(runtime.state.metrics.approvals).toBe(0);
      expect(runtime.state.plan.tasks.some((t) => t.level === 'strategy')).toBe(true);
    },
  );
  it('resumes checkpoints without repeating completed actions', async () => {
    const a = make();
    for (let i = 0; i < 12; i++) await a.runtime.step();
    const cp = await a.runtime.exportCheckpoint();
    const host = new DemoAdapter();
    await host.restore(cp.host);
    const resumed = new CommandRuntime({
      adapter: host,
      store: a.store,
      commanders: defaultCommanders(),
      policy,
    });
    await resumed.initialize();
    expect(resumed.state.receipts).toEqual(a.runtime.state.receipts);
    await resumed.step();
    expect(resumed.state.metrics.actions).toBe(cp.metrics.actions + 1);
    expect(new Set(resumed.state.receipts.map((r) => r.key)).size).toBe(
      resumed.state.receipts.length,
    );
  });
  it('fixed seeds reproduce every action and outcome', async () => {
    const a = make(),
      b = make();
    for (let i = 0; i < 25; i++) {
      await a.runtime.step();
      await b.runtime.step();
    }
    expect(await a.adapter.snapshot()).toEqual(await b.adapter.snapshot());
    expect(a.runtime.state.plan).toEqual(b.runtime.state.plan);
  });
  it('repairs only affected tasks and preserves completed progress history', async () => {
    const { runtime, adapter } = make();
    await runtime.step();
    adapter.inject({ id: 'activate-red', kind: 'turn' }, (o) => {
      o.activeSide = 'red';
    });
    await runtime.step();
    const before = runtime.state.plan;
    const red = before.tasks.find((t) => t.commanderId === 'red' && t.level === 'tactics')!;
    adapter.inject({ id: 'loss-test', kind: 'loss', unitIds: ['b1'] }, (o) => {
      o.activeSide = 'blue';
      o.units.find((u) => u.id === 'b1')!.hp = 0;
    });
    await runtime.step();
    expect(runtime.state.plan.tasks.some((t) => t.id === red.id)).toBe(true);
    expect(runtime.state.revisions.at(-1)?.scope).toEqual(['blue']);
    expect(Object.values(runtime.state.progress).some((p) => p.status === 'cancelled')).toBe(true);
  });
  it('higher-priority goals revise the plan without host overwrites', async () => {
    const { runtime } = make();
    await runtime.step();
    const goal: Goal = {
      id: 'mission',
      kind: 'withdraw',
      title: '撤至西侧',
      side: 'blue',
      target: '0,3',
      priority: 90,
      source: 'user',
      version: 2,
    };
    await runtime.updateGoals([goal]);
    await runtime.step();
    expect(runtime.state.goals.find((g) => g.side === 'blue')).toEqual(goal);
    expect(
      runtime.state.plan.tasks.find((t) => t.commanderId === 'blue' && t.level === 'tactics')
        ?.family,
    ).toBe('withdraw');
  });
  it('locked tasks persist through unrelated replanning', async () => {
    const { runtime, adapter } = make();
    await runtime.step();
    const task = runtime.state.plan.tasks.find((t) => t.level === 'tactics')!;
    await runtime.patch({
      baseVersion: runtime.state.plan.version,
      source: 'user',
      reason: '锁定',
      scope: [],
      events: [],
      lock: { taskId: task.id, locked: true },
    });
    adapter.inject({ id: 'block-1', kind: 'blocked' }, (o) => {
      o.map.locations.find((l) => l.id === '3,3')!.blocked = true;
    });
    await runtime.step();
    expect(runtime.state.plan.tasks.find((t) => t.id === task.id)?.locked).toBe(true);
  });
  it('pause cancels a pending model decision before execution', async () => {
    let entered!: () => void;
    const entry = new Promise<void>((r) => {
      entered = r;
    });
    const provider: DecisionProvider = {
      id: 'pending',
      evaluate: async () => {
        entered();
        return new Promise(() => {});
      },
    };
    const { runtime } = make(provider);
    const step = runtime.step();
    await entry;
    const pause = runtime.pause();
    await Promise.all([step, pause]);
    expect(runtime.status.state).toBe('paused');
    expect(runtime.state.metrics.actions).toBe(0);
  });
  it('manual commands win and remaining authorized units keep acting', async () => {
    const { runtime, adapter } = make();
    await runtime.step();
    const o = await adapter.observe();
    const action = (await adapter.legalActions(o, ['b2'])).find((a) => a.kind === 'defend')!;
    await runtime.manual(action.id);
    expect(runtime.state.receipts.at(-1)?.actionId).toBe(action.id);
    expect(
      runtime.state.plan.tasks
        .filter((t) => t.level === 'tactics')
        .every((t) => !t.unitIds.includes('b2')),
    ).toBe(true);
    await runtime.step();
    expect(runtime.status.state).not.toBe('stopped');
  });
});
describe('故障与并发', () => {
  it.each(['network', '429', 'invalid', 'timeout'])(
    '%s falls back without asking the user',
    async (failure) => {
      const provider: DecisionProvider = {
        id: 'fault',
        evaluate: async () => {
          if (failure === 'timeout') return new Promise(() => {});
          if (failure === 'invalid') return { confidence: 1, scores: {}, model: 'bad' };
          throw new Error(failure);
        },
      };
      const { runtime } = make(provider);
      await runtime.step();
      expect(runtime.state.metrics.actions).toBe(1);
      expect(runtime.state.metrics.fallbacks).toBeGreaterThan(0);
      expect(runtime.status.confirmations).toBe(0);
    },
  );
  it('rejects a stale model response after a host state change', async () => {
    const adapter = new DemoAdapter();
    let once = false;
    const provider: DecisionProvider = {
      id: 'stale',
      evaluate: async (r) => {
        if (!once) {
          adapter.inject({ id: 'external', kind: 'observation' });
          once = true;
        }
        return {
          scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.5])),
          confidence: 0.4,
          model: 'fake',
        };
      },
    };
    const runtime = new CommandRuntime({
      adapter,
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      provider,
      policy,
    });
    await runtime.step();
    expect(runtime.state.metrics.actions).toBe(0);
    expect(runtime.state.metrics.stale).toBe(1);
    await runtime.step();
    expect(runtime.state.metrics.actions).toBe(1);
  });
  it('serializes competing steps and deduplicates host retries', async () => {
    const { runtime, adapter } = make();
    await Promise.all(Array.from({ length: 8 }, () => runtime.step()));
    expect(runtime.state.metrics.actions).toBe(8);
    const o = await adapter.observe();
    const action = (
      await adapter.legalActions(
        o,
        o.units.map((u) => u.id),
      )
    )[0]!;
    const env = {
      sessionId: o.sessionId,
      stateVersion: o.version,
      planVersion: 1,
      key: 'test-key',
      action,
    };
    const [a, b] = await Promise.all([adapter.execute(env), adapter.execute(env)]);
    expect(a).toEqual(b);
    expect((await adapter.observe()).version).toBe(o.version + 1);
  });
  it('stops submitting when the pre-action checkpoint cannot be saved', async () => {
    const adapter = new DemoAdapter();
    const store: PlanStore = {
      load: async () => null,
      save: async () => {
        throw new Error('disk full');
      },
    };
    const runtime = new CommandRuntime({ adapter, store, commanders: defaultCommanders(), policy });
    await runtime.step();
    expect(runtime.status.state).toBe('stopped');
    expect((await adapter.observe()).version).toBe(0);
    expect(runtime.status.savedRevision).toBe(0);
  });
  it('reconciles a crash after host execution but before acknowledgement', async () => {
    const adapter = new DemoAdapter();
    const backing = new MemoryPlanStore();
    let fail = false;
    const store: PlanStore = {
      load: (s) => backing.load(s),
      save: async (cp, v) => {
        if (fail && !cp.pending) throw new Error('crash after execute');
        await backing.save(cp, v);
      },
    };
    const runtime = new CommandRuntime({ adapter, store, commanders: defaultCommanders(), policy });
    fail = true;
    await runtime.step();
    expect(runtime.status.state).toBe('stopped');
    expect((await adapter.observe()).version).toBe(1);
    const saved = await backing.load('demo-grid');
    expect(saved?.pending).toBeTruthy();
    fail = false;
    const resumed = new CommandRuntime({ adapter, store, commanders: defaultCommanders(), policy });
    await resumed.initialize();
    expect((await adapter.observe()).version).toBe(1);
    expect(resumed.state.metrics.actions).toBe(1);
    await resumed.step();
    expect((await adapter.observe()).version).toBe(2);
  });
  it('cooldown suppresses repeated failing calls and probes recovery', async () => {
    let count = 0;
    let failed = true;
    const provider: DecisionProvider = {
      id: 'recover',
      evaluate: async (r) => {
        count++;
        if (failed) throw new Error('429');
        return {
          scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.6])),
          confidence: 0.8,
          model: 'recovered',
        };
      },
    };
    let clockTime = 1000;
    const runtime = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      provider,
      policy,
      clock: { now: () => clockTime },
    });
    await runtime.step();
    const first = count;
    await runtime.step();
    expect(count).toBe(first);
    failed = false;
    clockTime += 40;
    await runtime.step();
    expect(runtime.status.provider).toBe('recovered');
  });
});
describe('扩展、能力与风格', () => {
  it('validates workflow cycles and missing dependencies', () => {
    const r = new Registry<DecisionStage>();
    const stage = (id: string, dependencies: string[]): DecisionStage => ({
      id,
      dependencies,
      version: '1',
      inputs: [],
      outputs: [],
      capabilities: [],
      config: {},
      budgetMs: 10,
      run: async () => {},
    });
    r.register(stage('a', ['b'])).register(stage('b', ['a']));
    expect(() => new Workflow(r, { id: 'cycle', stages: ['a', 'b'], capabilities: [] })).toThrow(
      'cycle',
    );
    expect(() => new Workflow(r, { id: 'missing', stages: ['a'], capabilities: [] })).toThrow(
      'dependency',
    );
  });
  it('all 14 style dimensions are neutral at 50 and directional at the extremes', () => {
    const styles = defaultStyles();
    expect(styles.all()).toHaveLength(14);
    for (const d of styles.all()) {
      const features = Object.fromEntries(
        [
          'flank',
          'fire',
          'commit',
          'objective',
          'concentration',
          'hold',
          'feint',
          'initiative',
          'risk',
          'safety',
          'mobility',
          'recon',
          'patience',
          'autonomy',
        ].map((k) => [k, 1]),
      );
      expect(d.contribution(features, 50)).toBe(0);
      expect(d.contribution(features, 100)).toBeGreaterThan(d.contribution(features, 0));
    }
    expect(styles.score({}, DEFAULT_STYLE)).toBe(0);
  });
  it('5 capabilities have measurable differences without unit boosts', async () => {
    const horizons: number[] = [];
    const candidates: number[] = [];
    for (const ability of Object.keys(PROFILES) as (keyof typeof PROFILES)[]) {
      const adapter = new DemoAdapter();
      const commanders = defaultCommanders().map((c) => ({ ...c, ability }));
      const runtime = new CommandRuntime({
        adapter,
        store: new MemoryPlanStore(),
        commanders,
        policy,
      });
      await runtime.step();
      horizons.push(runtime.state.metrics.maxHorizon);
      candidates.push(runtime.state.metrics.lastCandidates);
      expect((await adapter.observe()).units[0]!.maxHp).toBe(24);
    }
    expect(horizons).toEqual([1, 2, 3, 4, 6]);
    expect(candidates[4]).toBeGreaterThan(candidates[0]!);
  });
  it('a new doctrine, style and workflow stage work without core changes', async () => {
    const doctrines = defaultDoctrines();
    const base = doctrines.get('central-breakthrough');
    doctrines.register({ ...base, id: 'custom-raid', label: '自定义突袭', score: () => 100 });
    const styles = defaultStyles().register({
      id: 'custom',
      label: '自定义',
      low: '少',
      high: '多',
      effect: 'test',
      contribution: (f, v) => ((f.damage ?? 0) * v) / 100,
    });
    let seen = false;
    const runtime = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      policy,
      doctrines,
      styles,
      extraStages: [
        {
          id: 'audit',
          version: '1',
          dependencies: ['select'],
          inputs: ['selected'],
          outputs: [],
          capabilities: [],
          config: {},
          budgetMs: 10,
          run: async () => {
            seen = true;
          },
        },
      ],
    });
    await runtime.step();
    expect(seen).toBe(true);
    expect(runtime.state.plan.tasks.some((t) => t.doctrineId === 'custom-raid')).toBe(true);
  });
  it('rejects overlapping command ownership and cycles', () => {
    const commanders = defaultCommanders();
    commanders[1]!.unitIds.push('b1');
    expect(
      () =>
        new CommandRuntime({
          adapter: new DemoAdapter(),
          store: new MemoryPlanStore(),
          commanders,
        }),
    ).toThrow('multiple');
  });
  it('narrative scans only completed messages and lower priority cannot overwrite explicit goals', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      role: 'assistant',
      text: String(i),
      completed: i !== 9,
    }));
    expect(narrativeWindow(messages).map((m) => m.id)).toEqual(['3', '4', '5', '6', '7', '8']);
    const goal: Goal = {
      id: 'g',
      kind: 'eliminate',
      title: '任务',
      priority: 50,
      side: 'blue',
      source: 'user',
      version: 1,
    };
    expect(
      mergeGoals([goal], [{ ...goal, source: 'narrative', title: '冲突', version: 99 }]),
    ).toEqual([goal]);
  });
});
