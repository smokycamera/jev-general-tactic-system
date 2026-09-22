import { expect, it } from 'vitest';
import {
  CommandRuntime,
  MemoryPlanStore,
  clone,
  resolveTarget,
  rememberLocations,
  evaluationContext,
  PROFILES,
  defaultCapabilityResolver,
} from '@jev/core';
import type {
  ActionEnvelope,
  ActionReceipt,
  BattleAction,
  BattleAdapter,
  Commander,
  DecisionRequest,
  Observation,
  TacticalMemory,
} from '@jev/core';

const commander: Commander = {
  id: 'blue',
  name: 'blue',
  side: 'blue',
  unitIds: ['scout'],
  ability: 'skilled',
  style: {},
};
class FogHost implements BattleAdapter {
  readonly id = 'line-world';
  sight = 2;
  commands: ActionEnvelope[] = [];
  receipts = new Map<string, ActionReceipt>();
  data: Observation = {
    sessionId: 'adaptive',
    version: 0,
    turn: 1,
    activeSide: 'blue',
    ended: false,
    events: [],
    map: {
      kind: 'graph',
      locations: Array.from({ length: 9 }, (_, i) => ({
        id: 'p' + i,
        label: 'p' + i,
        x: i,
        y: 0,
        cover: 0,
        blocked: false,
        neighbors: [i - 1, i + 1].filter((n) => n >= 0 && n < 9).map((n) => 'p' + n),
      })),
    },
    units: [
      {
        id: 'scout',
        name: 'scout',
        side: 'blue',
        location: 'p0',
        hp: 20,
        maxHp: 20,
        attack: 2,
        range: 2,
        ap: 1,
        ammo: 99,
        tags: [],
      },
      {
        id: 'enemy',
        name: 'enemy',
        side: 'red',
        location: 'p8',
        hp: 100,
        maxHp: 100,
        attack: 2,
        range: 2,
        ap: 1,
        ammo: 99,
        tags: [],
      },
    ],
    goals: [
      {
        id: 'mission',
        title: 'Find and defeat contacts',
        side: 'blue',
        kind: 'eliminate',
        priority: 80,
        source: 'host',
        version: 1,
      },
    ],
    capabilities: {
      fullyObservable: false,
      mechanisms: { movement: true, 'ranged-fire': true, ammo: false },
    },
  };
  async observe() {
    const o = clone(this.data),
      at = Number(o.units[0]!.location.slice(1));
    o.units = o.units.filter(
      (u) => u.side === 'blue' || Math.abs(Number(u.location.slice(1)) - at) <= this.sight,
    );
    return o;
  }
  async legalActions(o: Observation, ids: readonly string[]): Promise<BattleAction[]> {
    const actor = o.units[0]!;
    if (!ids.includes(actor.id)) return [];
    const actions: BattleAction[] = [
      { id: 'wait', unitId: actor.id, kind: 'wait', cost: 1, features: {} },
    ];
    for (const next of o.map.locations.find((l) => l.id === actor.location)!.neighbors)
      actions.push({
        id: 'move:' + next,
        unitId: actor.id,
        kind: 'move',
        destination: next,
        cost: 1,
        features: {},
      });
    for (const target of o.units.filter(
      (u) =>
        u.side !== 'blue' &&
        Math.abs(Number(u.location.slice(1)) - Number(actor.location.slice(1))) <= actor.range,
    ))
      actions.push({
        id: 'attack:' + target.id,
        unitId: actor.id,
        kind: 'attack',
        targetId: target.id,
        cost: 1,
        features: { damage: 0.1 },
      });
    return actions;
  }
  async execute(e: ActionEnvelope) {
    const old = this.receipts.get(e.key);
    if (old) return clone(old);
    expect(e.stateVersion).toBe(this.data.version);
    expect(
      (await this.legalActions(await this.observe(), [e.action.unitId])).some(
        (a) => a.id === e.action.id,
      ),
    ).toBe(true);
    this.commands.push(clone(e));
    if (e.action.destination) this.data.units[0]!.location = e.action.destination;
    if (e.action.targetId) this.data.units.find((u) => u.id === e.action.targetId)!.hp -= 2;
    this.data.version++;
    this.data.turn++;
    const r: ActionReceipt = {
      key: e.key,
      actionId: e.action.id,
      stateVersion: this.data.version,
      applied: true,
      detail: 'done',
      execution: 'succeeded',
    };
    this.receipts.set(e.key, r);
    return r;
  }
  async receipt(key: string) {
    return clone(this.receipts.get(key) ?? null);
  }
  async snapshot() {
    return null;
  }
}

it('searches without hidden coordinates, resumes exploration, and attacks on contact', async () => {
  const host = new FogHost(),
    store = new MemoryPlanStore();
  let runtime = new CommandRuntime({ adapter: host, store, commanders: [commander] });
  await runtime.step();
  expect(host.commands[0]!.action.kind).toBe('move');
  expect(runtime.state.plan.tasks.find((t) => t.level === 'tactics')!.doctrineId).toBe(
    'search-contact',
  );
  expect(JSON.stringify(runtime.state.plan)).not.toContain('"unitId":"enemy"');
  const before = await runtime.exportCheckpoint();
  expect(before.memory!.blue!.visited).toContain('p0');
  runtime = new CommandRuntime({ adapter: host, store, commanders: [commander] });
  for (let i = 0; i < 9; i++) await runtime.step();
  expect(host.commands.some((e) => e.action.kind === 'attack')).toBe(true);
  expect(host.commands.filter((e) => e.action.kind === 'wait')).toHaveLength(0);
  expect(new Set(host.commands.map((e) => e.key)).size).toBe(host.commands.length);
});

it('updates a visible contact locally without repeatedly consulting the model or chasing its old cell', async () => {
  const host = new FogHost();
  host.sight = 20;
  const requests: DecisionRequest[] = [];
  const runtime = new CommandRuntime({
    adapter: host,
    store: new MemoryPlanStore(),
    commanders: [commander],
    provider: {
      id: 'test',
      evaluate: async (r) => {
        requests.push(clone(r));
        return {
          model: 'test',
          confidence: 0.9,
          scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.5])),
        };
      },
    },
  });
  await runtime.step();
  const calls = requests.length;
  const version = runtime.state.plan.version;
  host.data.units[1]!.location = 'p0';
  host.data.version++;
  await runtime.step();
  expect(host.commands.at(-1)!.action.kind).toBe('attack');
  expect(requests).toHaveLength(calls);
  expect(runtime.state.plan.version).toBe(version);
  const engage = runtime.state.plan.tasks
    .find((t) => t.level === 'tactics')!
    .network!.steps.find((s) => s.task === 'engage')!;
  expect(engage.target).toBe('p0');
  expect(engage.targetUnitId).toBe('enemy');
});

it('keeps fixed objectives independent of contact motion and holds a capture point until the host ends it', async () => {
  const host = new FogHost();
  host.sight = 20;
  host.data.units[0]!.location = 'p4';
  host.data.goals[0] = { ...host.data.goals[0]!, kind: 'capture', target: 'p4' };
  const runtime = new CommandRuntime({
    adapter: host,
    store: new MemoryPlanStore(),
    commanders: [commander],
  });
  await runtime.step();
  host.data.units[1]!.location = 'p6';
  host.data.version++;
  await runtime.step();
  const task = runtime.state.plan.tasks.find((t) => t.level === 'tactics')!;
  expect(task.target).toEqual({ kind: 'fixed', location: 'p4' });
  expect(task.network!.steps.every((s) => !s.targetUnitId)).toBe(true);
  expect(runtime.state.progress[task.id]!.status).toBe('active');
  expect(host.data.units[0]!.location).toBe('p4');
});

it("provides executable candidate steps and only this side's bounded durable action history", async () => {
  const host = new FogHost();
  host.sight = 20;
  const store = new MemoryPlanStore(),
    requests: DecisionRequest[] = [];
  const provider = {
    id: 'test',
    evaluate: async (r: DecisionRequest) => {
      requests.push(clone(r));
      return {
        model: 'test',
        confidence: 0.8,
        scores: Object.fromEntries(r.candidates.map((c) => [c.id, 0.5])),
      };
    },
  };
  let runtime = new CommandRuntime({ adapter: host, store, commanders: [commander], provider });
  for (let i = 0; i < 28; i++) await runtime.step();
  const cp = await runtime.exportCheckpoint();
  expect(cp.memory!.blue!.history).toHaveLength(24);
  runtime = new CommandRuntime({ adapter: host, store, commanders: [commander], provider });
  host.data.units[1]!.id = 'replacement';
  host.data.version++;
  await runtime.step();
  const r = requests.at(-1)!;
  expect(r.recentActions).toHaveLength(24);
  expect(
    r.recentActions!.every((a) => a.action.unitId === 'scout' && a.outcome === 'succeeded'),
  ).toBe(true);
  expect(r.candidates.every((c) => c.steps!.length > 0)).toBe(true);
  expect(r.candidates.some((c) => c.steps!.some((s) => s.targetUnitId === 'replacement'))).toBe(
    true,
  );
});

it('search memory avoids immediately revisiting waypoints and uses no unseen units', async () => {
  const host = new FogHost(),
    o = await host.observe();
  const memory: TacticalMemory = { visited: [], history: [] };
  const c = {
    ...evaluationContext(o, commander, PROFILES.skilled!, o.goals),
    capabilities: defaultCapabilityResolver.resolve(o),
    memory,
  };
  rememberLocations(memory, o, 'blue');
  const first = resolveTarget(c)!;
  expect(first.kind).toBe('search');
  expect(first.location).not.toBe('p0');
  o.units[0]!.location = first.location;
  rememberLocations(memory, o, 'blue');
  const next = resolveTarget(c, first)!;
  expect(next.location).not.toBe(first.location);
  expect(next.location).not.toBe('p0');
});

it.each([0, 0.01, 0.4])(
  'weights model evidence continuously at confidence %s',
  async (confidence) => {
    const host = new FogHost();
    host.sight = 20;
    const runtime = new CommandRuntime({
      adapter: host,
      store: new MemoryPlanStore(),
      commanders: [commander],
      provider: {
        id: 'weighted',
        evaluate: async (r) => ({
          model: 'weighted',
          confidence,
          scores: Object.fromEntries(r.candidates.map((c, i) => [c.id, i === 1 ? 1 : 0])),
        }),
      },
    });
    await runtime.step();
    const selection = runtime.state.lastModelSelection!;
    expect(selection.confidence).toBe(confidence);
    if (confidence < 0.1) expect(selection.selectedId).toBe(selection.localId);
    else expect(selection.selectedId).not.toBe(selection.localId);
    expect((await runtime.exportCheckpoint()).lastModelSelection).toEqual(selection);
  },
);
