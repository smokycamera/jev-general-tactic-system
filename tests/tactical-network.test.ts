import { describe, expect, it } from 'vitest';
import {
  CommandRuntime,
  HtnPlanner,
  NetworkExecutor,
  MemoryPlanStore,
  Registry,
  PROFILES,
  defaultCapabilityResolver,
  defaultDoctrines,
  defaultHtnMethods,
  defaultModifiers,
  defaultOperators,
  evaluationContext,
  executionProgress,
  makeSpec,
  taskFromMethod,
  clone,
  orderedTasks,
  conditionMet,
} from '@jev/core';
import type {
  ActionEnvelope,
  Commander,
  DecisionProvider,
  HtnMethod,
  TaskOperator,
  Task,
  TaskProgress,
  TaskSpec,
} from '@jev/core';
import { DemoAdapter, createObservation, defaultCommanders } from '@jev/demo';
import { createFortificationRuntime } from '../examples/task-network.js';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';

function context() {
  const o = createObservation();
  const cmd = { ...defaultCommanders()[0]!, unitIds: ['b1', 'b2', 'b3'], ability: 'master' };
  return {
    ...evaluationContext(o, cmd, PROFILES.master!, o.goals),
    capabilities: defaultCapabilityResolver.resolve(o),
  };
}
function operator(id: string, effects: Record<string, boolean> = {}, needs?: string): TaskOperator {
  return {
    id,
    canPlan: (c) => !needs || c.facts[needs] === true,
    predict: () => effects,
    observe: () => 'succeeded',
    score: () => undefined,
  };
}
function runtimeFor(adapter = new DemoAdapter(), tactics: Commander['tactics'] = {}) {
  const commanders = defaultCommanders();
  commanders[0]!.tactics = tactics;
  return new CommandRuntime({
    adapter,
    store: new MemoryPlanStore(),
    commanders,
    policy: { tickDelayMs: 0, modelActionMode: 'local' },
  });
}
describe('HTN分解与依赖', () => {
  it('scopes predicted effect keys to each nested branch', () => {
    const c = context();
    const methods = new Registry<HtnMethod>().register({
      id: 'approach',
      task: 'approach',
      expand: (p) => [makeSpec('move', 'move', p.spec.unitIds, [], p.spec.target)],
    });
    const result = new HtnPlanner(defaultOperators(), methods).plan(
      [
        makeSpec('left', 'approach', ['b1'], [], '2,1'),
        makeSpec('right', 'approach', ['b2'], [], '2,5'),
      ],
      c,
      c.capabilities,
      100,
    )!;
    expect(result.steps.map((s) => s.effects)).toEqual([
      { 'at:left/move': '2,1' },
      { 'at:right/move': '2,5' },
    ]);
  });
  it('backtracks a method when a later required task becomes impossible without mutating the host', () => {
    const c = context(),
      before = clone(c.observation);
    const operators = new Registry<TaskOperator>()
      .register(operator('supply', { ready: true }))
      .register(operator('consume', { ready: false }))
      .register(operator('keep'))
      .register(operator('assault', {}, 'ready'));
    const methods = new Registry<HtnMethod>()
      .register({
        id: 'bad',
        task: 'choose',
        expand: () => [makeSpec('consume', 'consume', ['b1'])],
      })
      .register({ id: 'good', task: 'choose', expand: () => [makeSpec('keep', 'keep', ['b1'])] });
    const p = new HtnPlanner(operators, methods);
    const result = p.plan(
      [
        makeSpec('supply', 'supply', ['b1']),
        makeSpec('choice', 'choose', ['b1'], ['supply']),
        makeSpec('finish', 'assault', ['b1'], ['choice']),
      ],
      c,
      c.capabilities,
      100,
    )!;
    expect(result.methods).toEqual(['good']);
    expect(result.steps.map((s) => s.task)).toEqual(['supply', 'keep', 'assault']);
    expect(c.observation).toEqual(before);
  });
  it('never borrows predicted effects from an unordered parallel branch', () => {
    const c = context(),
      p = new HtnPlanner(
        new Registry<TaskOperator>()
          .register(operator('prepare', { ready: true }))
          .register(operator('attack', {}, 'ready')),
        new Registry<HtnMethod>(),
      );
    expect(
      p.plan(
        [makeSpec('p', 'prepare', ['b1']), makeSpec('a', 'attack', ['b2'])],
        c,
        c.capabilities,
        40,
      ),
    ).toBeUndefined();
    expect(
      p.plan(
        [makeSpec('p', 'prepare', ['b1']), makeSpec('a', 'attack', ['b2'], ['p'])],
        c,
        c.capabilities,
        40,
      )?.steps,
    ).toHaveLength(2);
  });
  it('bounds recursive domains and rejects invalid dependency graphs', () => {
    const c = context();
    const methods = new Registry<HtnMethod>().register({
      id: 'loop',
      task: 'loop',
      expand: () => [makeSpec('again', 'loop', [])],
    });
    expect(
      new HtnPlanner(new Registry<TaskOperator>(), methods).plan(
        [makeSpec('root', 'loop', [])],
        c,
        c.capabilities,
        12,
      ),
    ).toBeUndefined();
    expect(() =>
      orderedTasks([makeSpec('a', 'x', [], ['b']), makeSpec('b', 'x', [], ['a'])]),
    ).toThrow('cycle');
    expect(() => orderedTasks([makeSpec('a', 'x', [], ['missing'])])).toThrow('missing');
  });
  it('skips unavailable optional mechanics and reconnects dependencies', () => {
    const c = context();
    const ops = new Registry<TaskOperator>()
      .register({ ...operator('smoke'), requirements: ['smoke'] })
      .register(operator('attack'));
    const specs = [
      { ...makeSpec('s', 'smoke', ['b1']), optional: true },
      makeSpec('a', 'attack', ['b1'], ['s']),
    ];
    const result = new HtnPlanner(ops, new Registry<HtnMethod>()).plan(
      specs,
      c,
      c.capabilities,
      40,
    )!;
    expect(result.steps.map((s) => s.task)).toEqual(['attack']);
    expect(result.steps[0]!.after).toEqual([]);
    expect(result.notes).toHaveLength(1);
    specs[0]!.optional = false;
    expect(
      new HtnPlanner(ops, new Registry<HtnMethod>()).plan(specs, c, c.capabilities, 40),
    ).toBeUndefined();
  });
});
describe('能力协商与战术目录', () => {
  it.each(['grid', 'regions'])(
    'a legacy %s adapter completes a battle with no new declarations',
    async (kind) => {
      const o = createObservation(kind);
      delete o.capabilities;
      const host = new DemoAdapter(o),
        runtime = runtimeFor(host, {
          doctrineId: 'infiltration',
          modifiers: ['smoke-concealment', 'suppression'],
        });
      await runtime.start(1000);
      expect(runtime.status.state, runtime.status.detail).toBe('ended');
      expect(
        runtime.state.plan.tasks
          .filter((t) => t.level === 'tactics')
          .every((t) => t.doctrineId !== 'infiltration'),
      ).toBe(true);
      expect(runtime.state.metrics.approvals).toBe(0);
    },
  );
  it('explicitly absent movement, ammo, fog, smoke and morale still permits basic legal combat', async () => {
    const o = createObservation('regions');
    o.capabilities = {
      mechanisms: {
        movement: false,
        'ranged-fire': false,
        ammo: false,
        visibility: false,
        smoke: false,
        morale: false,
        flanking: false,
        terrain: false,
        recon: false,
      },
    };
    const host = new DemoAdapter(o),
      runtime = runtimeFor(host, {
        modifiers: defaultModifiers()
          .all()
          .map((m) => m.id),
      });
    await runtime.start(1000);
    expect(runtime.status.state, runtime.status.detail).toBe('ended');
    expect(
      runtime.state.plan.tasks.some((t) => t.network?.notes.some((n) => n.includes('不支持'))),
    ).toBe(true);
  });
  it('all five ability levels retain the necessary assault after preparation', () => {
    const doctrines = defaultDoctrines(),
      ops = defaultOperators(),
      planner = new HtnPlanner(ops, defaultHtnMethods());
    for (const profile of Object.values(PROFILES)) {
      const c = context();
      c.profile = profile;
      const spec = doctrines.get('fire-then-assault').decompose!(c);
      const plan = planner.plan(spec, c, c.capabilities, 32 + profile.horizon * 32)!;
      expect(plan.steps.some((s) => s.task === 'fire')).toBe(true);
      expect(plan.steps.some((s) => s.task === 'engage')).toBe(true);
    }
  });
  it('left and right parameters produce different reachable staging positions', () => {
    const c = context(),
      method = defaultDoctrines().get('flank-breakthrough');
    c.commander.tactics = { parameters: { direction: 'left' } };
    const left = method.decompose!(c)[0]!.target;
    c.commander.tactics = { parameters: { direction: 'right' } };
    const right = method.decompose!(c)[0]!.target;
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    expect(left).not.toBe(right);
  });
  it('catalogue depth never adds family model calls and respects a global decision cap', async () => {
    let calls = 0;
    const provider: DecisionProvider = {
      id: 'count',
      evaluate: async (r) => {
        calls++;
        return {
          scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.5])),
          confidence: 0.8,
          model: 'count',
        };
      },
    };
    const runtime = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      provider,
      policy: { maxModelCallsPerDecision: 1, decisionBudgetMs: 5000 },
    });
    await runtime.step();
    expect(calls).toBe(1);
    expect(runtime.state.records.every((r) => r.request.purpose !== 'family')).toBe(true);
    expect(runtime.state.metrics.actions).toBe(1);
  });
  it('a custom mechanic, operator, decomposition and modifier work without core edits', async () => {
    const o = createObservation('regions');
    o.capabilities!.mechanisms!.teleport = true;
    const host = new DemoAdapter(o),
      ops = defaultOperators();
    ops.register({ ...ops.get('hold'), id: 'custom-guard', requirements: ['teleport'] });
    const doctrines = defaultDoctrines();
    doctrines.register({
      ...doctrines.get('hold-position'),
      id: 'custom-teleport',
      label: '自定义',
      requirements: ['teleport'],
      decompose: (c) => [makeSpec('guard', 'custom-guard', c.commander.unitIds, [], c.goal.target)],
    });
    const modifiers = defaultModifiers().register({
      id: 'custom-extra',
      label: '自定义辅助',
      requirements: ['teleport'],
      apply: (specs) => specs.map((s) => ({ ...s, data: { radius: 2 } })),
    });
    const commanders = defaultCommanders();
    commanders[0]!.tactics = { doctrineId: 'custom-teleport', modifiers: ['custom-extra'] };
    const runtime = new CommandRuntime({
      adapter: host,
      store: new MemoryPlanStore(),
      commanders,
      operators: ops,
      doctrines,
      modifiers,
    });
    await runtime.step();
    const task = runtime.state.plan.tasks.find(
      (t) => t.commanderId === 'blue' && t.level === 'tactics',
    )!;
    expect(task.doctrineId).toBe('custom-teleport');
    expect(task.network!.steps[0]!.data?.radius).toBe(2);
    expect(runtime.status.state).not.toBe('stopped');
  });
});
function executable(specs: TaskSpec[]) {
  const c = context(),
    ops = defaultOperators(),
    planner = new HtnPlanner(ops, defaultHtnMethods());
  const method = defaultDoctrines().get('central-breakthrough');
  const task = taskFromMethod('test', c.commander, c.goal, 1, method, c, []);
  task.network = planner.plan(specs, c, c.capabilities, 200)!;
  const progress: TaskProgress = {
    taskId: task.id,
    status: 'active',
    phase: 0,
    enteredTurn: 1,
    actions: 0,
    execution: executionProgress(),
  };
  return {
    c,
    ops,
    task,
    progress,
    executor: new NetworkExecutor(ops, { maxIdleTurns: 2, maxRepairs: 1 }),
  };
}
describe('持续执行与恢复', () => {
  it('a later start request survives an unfinished single step', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowHost extends DemoAdapter {
      async execute(e: ActionEnvelope) {
        entered();
        await held;
        return super.execute(e);
      }
    }
    const runtime = runtimeFor(new SlowHost());
    const single = runtime.singleStep();
    await started;
    const automatic = runtime.start(2);
    release();
    await Promise.all([single, automatic]);
    expect(runtime.state.metrics.actions).toBe(3);
    expect(runtime.status.state).toBe('idle');
    expect((await runtime.exportCheckpoint()).paused).toBe(false);
  });
  it('an attack preference cannot override an explicit withdrawal goal', async () => {
    const o = createObservation();
    o.goals = [
      {
        id: 'retreat',
        title: '撤退命令',
        version: 1,
        side: 'blue',
        kind: 'withdraw',
        target: '0,3',
        priority: 10,
        source: 'user',
      },
    ];
    const runtime = runtimeFor(new DemoAdapter(o), { doctrineId: 'frontal-attack' });
    await runtime.step();
    const task = runtime.state.plan.tasks.find(
      (t) => t.commanderId === 'blue' && t.level === 'tactics',
    )!;
    expect(defaultDoctrines().get(task.doctrineId).family).toBe('withdraw');
    expect(task.network!.steps.some((s) => s.task === 'withdraw')).toBe(true);
  });
  it('waits after host rejection and excludes that action until the state changes', async () => {
    class RejectHost extends DemoAdapter {
      submitted: ActionEnvelope[] = [];
      async execute(e: ActionEnvelope) {
        this.submitted.push(e);
        return {
          key: e.key,
          actionId: e.action.id,
          stateVersion: e.stateVersion,
          applied: false,
          detail: 'not ready',
        };
      }
    }
    const host = new RejectHost(),
      runtime = runtimeFor(host, { doctrineId: 'frontal-attack' });
    await runtime.start(10);
    expect(runtime.status.state).toBe('waiting');
    expect(host.submitted).toHaveLength(1);
    expect(runtime.state.metrics.actions).toBe(0);
    await runtime.step();
    expect(new Set(host.submitted.map((e) => e.action.id)).size).toBe(host.submitted.length);
  });
  it('a fire preparation task cannot release the assault merely because turns passed', () => {
    const c = context(),
      specs = defaultDoctrines().get('fire-then-assault').decompose!(c),
      x = executable(specs);
    x.executor.update(x.task, x.progress, x.c, []);
    const fire = x.task.network!.steps.find((s) => s.task === 'fire')!;
    const attack = x.task.network!.steps.find((s) => s.task === 'engage')!;
    expect(x.progress.execution!.steps[fire.id]!.status).toBe('running');
    expect(x.progress.execution!.steps[attack.id]!.status).toBe('pending');
    x.c.observation.turn = 9;
    x.executor.update(x.task, x.progress, x.c, []);
    expect(x.progress.execution!.steps[attack.id]!.status).toBe('pending');
  });
  it('an actual support action unlocks dependent maneuver and assault', async () => {
    const o = createObservation();
    o.map.locations.forEach((l) => (l.blocked = false));
    o.units.find((u) => u.id === 'r1')!.location = '3,3';
    const host = new DemoAdapter(o),
      runtime = runtimeFor(host, { doctrineId: 'fire-then-assault' });
    await runtime.step();
    const task = runtime.state.plan.tasks.find(
      (t) => t.commanderId === 'blue' && t.level === 'tactics',
    )!;
    const fire = task.network!.steps.find((s) => s.task === 'fire')!;
    expect(runtime.state.receipts[0]!.actionId).toMatch(/^b2:attack:/);
    expect(runtime.state.progress[task.id]!.execution!.steps[fire.id]!.actions.attack).toBe(1);
    await runtime.step();
    expect(runtime.state.progress[task.id]!.execution!.steps[fire.id]!.status).toBe('succeeded');
  });
  it('repairs one blocked wing while preserving the completed fixing task', () => {
    const x = executable([
      makeSpec('fix', 'fix', ['b2'], [], '8,3'),
      { ...makeSpec('wing', 'move', ['b1'], [], '2,5'), data: { radius: 0 } },
      makeSpec('attack', 'engage', ['b1', 'b2'], ['fix', 'wing'], '8,3'),
    ]);
    x.executor.update(x.task, x.progress, x.c, []);
    x.progress.execution!.steps.fix!.actions.attack = 1;
    x.executor.update(x.task, x.progress, x.c, []);
    x.c.observation.map.locations.find((l) => l.id === '2,5')!.blocked = true;
    x.executor.update(x.task, x.progress, x.c, ['blocked']);
    expect(x.progress.execution!.steps.fix!.status).toBe('succeeded');
    expect(x.task.network!.steps.find((s) => s.id === 'wing')!.target).not.toBe('2,5');
    expect(x.progress.execution!.repairs).toBe(1);
    expect(x.progress.execution!.steps.attack!.status).toBe('pending');
  });
  it('lack of progress is bounded and deliberate holding does not time out', () => {
    const x = executable([{ ...makeSpec('move', 'move', ['b1'], [], '8,3'), data: { radius: 0 } }]);
    x.executor.update(x.task, x.progress, x.c, []);
    x.c.observation.turn += 3;
    x.executor.update(x.task, x.progress, x.c, []);
    x.c.observation.turn += 3;
    x.executor.update(x.task, x.progress, x.c, []);
    x.c.observation.turn += 3;
    x.executor.update(x.task, x.progress, x.c, []);
    expect(x.progress.execution!.steps.move!.status).toBe('failed');
    const hold = executable([makeSpec('hold', 'hold', ['b1'], [], '1,1')]);
    hold.executor.update(hold.task, hold.progress, hold.c, []);
    hold.c.observation.turn += 50;
    hold.executor.update(hold.task, hold.progress, hold.c, []);
    expect(hold.progress.execution!.steps.hold!.status).toBe('running');
  });
  it('acknowledged ongoing host commands survive recovery and never count as completed preparation', async () => {
    const o = createObservation();
    o.map.locations.forEach((l) => (l.blocked = false));
    o.units.find((u) => u.id === 'r1')!.location = '3,3';
    class AsyncHost extends DemoAdapter {
      async execute(e: ActionEnvelope) {
        return { ...(await super.execute(e)), execution: 'running' as const };
      }
    }
    const host = new AsyncHost(o),
      store = new MemoryPlanStore(),
      cmds = defaultCommanders();
    cmds[0]!.tactics = { doctrineId: 'fire-then-assault' };
    const a = new CommandRuntime({ adapter: host, store, commanders: cmds });
    await a.step();
    const saved = await a.exportCheckpoint(),
      key = saved.activeOrders![0]!.key;
    const b = new CommandRuntime({ adapter: host, store, commanders: cmds });
    await b.initialize();
    await b.step();
    const task = b.state.plan.tasks.find((t) => t.commanderId === 'blue' && t.level === 'tactics')!;
    const fire = task.network!.steps.find((s) => s.task === 'fire')!;
    expect(b.state.progress[task.id]!.execution!.steps[fire.id]!.status).toBe('running');
    expect(b.state.receipts.filter((r) => r.actionId.startsWith('b2:'))).toHaveLength(1);
    host.inject({ id: 'done', kind: 'observation' }, (o) => (o.orders = { [key]: 'succeeded' }));
    await b.step();
    expect(b.state.progress[task.id]!.execution!.steps[fire.id]!.status).toBe('succeeded');
  });
  it('missing enemies in a partial observation are never treated as confirmed elimination', () => {
    const x = executable([makeSpec('attack', 'engage', ['b1'], [], '8,3')]);
    x.c.observation.units = x.c.observation.units.filter((u) => u.side === 'blue');
    x.c.capabilities.fullyObservable = false;
    x.c.observation.capabilities = { fullyObservable: false };
    x.executor.update(x.task, x.progress, x.c, []);
    expect(x.progress.execution!.steps.attack!.status).toBe('running');
    expect(conditionMet({ kind: 'no-enemy' }, x.c.observation, x.task, x.progress, x.c.goal)).toBe(
      false,
    );
  });
});

describe('扩展契约与保存格式', () => {
  it('the documented optional mechanic example works without that mechanic', async () => {
    const commanders = defaultCommanders();
    commanders[0]!.tactics = { doctrineId: 'fortified-position' };
    const runtime = createFortificationRuntime(new DemoAdapter(), commanders);
    await runtime.step();
    const task = runtime.state.plan.tasks.find(
      (t) => t.commanderId === 'blue' && t.level === 'tactics',
    )!;
    expect(task.doctrineId).toBe('fortified-position');
    expect(task.network!.methods).toContain('ordinary-hold');
    expect(task.network!.steps.some((s) => s.task === 'entrench')).toBe(false);
    expect(runtime.state.metrics.actions).toBe(1);
  });
  it('exported plans match the published schema including networks and extension metadata', async () => {
    const runtime = runtimeFor();
    await runtime.step();
    const config = JSON.parse(await readFile('schemas/config.schema.json', 'utf8'));
    const plan = JSON.parse(await readFile('schemas/plan.schema.json', 'utf8'));
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(config, 'config.schema.json');
    const validate = ajv.compile(plan);
    expect(validate(runtime.state.plan), ajv.errorsText(validate.errors)).toBe(true);
  });
});
