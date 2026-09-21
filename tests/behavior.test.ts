import { describe, expect, it } from 'vitest';
import {
  CommandRuntime,
  MemoryPlanStore,
  distance,
  mergeGoals,
  PROFILES,
  defaultDoctrines,
  evaluationContext,
} from '@jev/core';
import type { Commander, Goal } from '@jev/core';
import { DemoAdapter, createObservation, defaultCommanders } from '@jev/demo';
const policy = { tickDelayMs: 0 };
describe('目标、风格与连续性边界', () => {
  it('a low-priority source cannot take over via a different goal id', () => {
    const user: Goal = {
      id: 'user-retreat',
      kind: 'withdraw',
      title: '撤退',
      target: '0,3',
      side: 'blue',
      source: 'user',
      version: 1,
      priority: 20,
    };
    const narrative: Goal = {
      ...user,
      id: 'narrative-attack',
      kind: 'capture',
      source: 'narrative',
      priority: 100,
    };
    expect(mergeGoals([user], [narrative])[0]).toEqual(user);
  });
  it('changing ability revises the future horizon at the next boundary', async () => {
    const runtime = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      policy,
    });
    await runtime.step();
    const before = runtime.state.plan.tasks.find(
      (t) => t.commanderId === 'blue' && t.level === 'tactics',
    )!;
    await runtime.updateCommander('blue', { ability: 'master', style: {} });
    await runtime.step();
    const after = runtime.state.plan.tasks.find(
      (t) => t.commanderId === 'blue' && t.level === 'tactics',
    )!;
    expect(after.id).not.toBe(before.id);
    expect(after.phases).toHaveLength(6);
  });
  it('flank preference changes the selected doctrine without extra information', async () => {
    const choices: string[] = [];
    for (const flank of [0, 100]) {
      const commanders = defaultCommanders();
      commanders[0]!.ability = 'master';
      commanders[0]!.style = { flank };
      const runtime = new CommandRuntime({
        adapter: new DemoAdapter(),
        store: new MemoryPlanStore(),
        commanders,
        policy,
      });
      await runtime.step();
      choices.push(
        runtime.state.plan.tasks.find((t) => t.commanderId === 'blue' && t.level === 'tactics')!
          .doctrineId,
      );
    }
    expect(choices[0]).toBe('central-breakthrough');
    expect(choices[1]).not.toBe(choices[0]);
  });
  it('cannot choose a fire-preparation method with no usable ranged unit', async () => {
    const observation = createObservation();
    for (const u of observation.units) u.ammo = 0;
    const commander = defaultCommanders()[0]!;
    commander.style = { firepower: 100 };
    const context = evaluationContext(observation, commander, PROFILES.master!, observation.goals);
    expect(defaultDoctrines().get('fire-then-assault').applicable(context)).toBe(false);
  });
  it('user withdrawal target changes the actual first move', async () => {
    const adapter = new DemoAdapter();
    const commanders: Commander[] = [
      { id: 'blue', name: 'blue', side: 'blue', unitIds: ['b1'], ability: 'skilled', style: {} },
    ];
    const goal: Goal = {
      id: 'mission',
      title: '撤离',
      kind: 'withdraw',
      side: 'blue',
      target: '0,1',
      priority: 90,
      source: 'user',
      version: 2,
    };
    const runtime = new CommandRuntime({
      adapter,
      store: new MemoryPlanStore(),
      commanders,
      goals: [goal],
      policy,
    });
    const before = await adapter.observe();
    await runtime.step();
    const after = await adapter.observe();
    expect(after.units.find((u) => u.id === 'b1')!.location).toBe('0,1');
    expect(runtime.state.receipts[0]?.actionId).toBe('b1:move:0,1');
    expect(before.units[0]!.hp).toBe(after.units[0]!.hp);
  });
  it('the same loss never causes an endless revision loop', async () => {
    const adapter = new DemoAdapter();
    const runtime = new CommandRuntime({
      adapter,
      store: new MemoryPlanStore(),
      commanders: defaultCommanders(),
      policy,
    });
    await runtime.step();
    adapter.inject({ id: 'one-loss', kind: 'loss', unitIds: ['b3'] }, (o) => {
      o.units.find((u) => u.id === 'b3')!.hp = 0;
    });
    await runtime.step();
    const version = runtime.state.plan.version;
    for (let i = 0; i < 3; i++) await runtime.step();
    expect(runtime.state.plan.version).toBe(version);
  });
  it('all task parents exist even in a three-level chain of command', async () => {
    const commanders = defaultCommanders();
    commanders.push({
      id: 'observer',
      name: '观察指挥',
      side: 'blue',
      parentId: 'blue-wing',
      unitIds: [],
      ability: 'master',
      style: {},
    });
    const runtime = new CommandRuntime({
      adapter: new DemoAdapter(),
      store: new MemoryPlanStore(),
      commanders,
      policy,
    });
    await runtime.step();
    const tasks = runtime.state.plan.tasks;
    for (const task of tasks)
      if (task.parentId) expect(tasks.some((t) => t.id === task.parentId)).toBe(true);
  });
});
