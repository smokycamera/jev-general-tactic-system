import { it, expect } from 'vitest';
import { CommandRuntime, MemoryPlanStore, NetworkExecutor, defaultOperators } from '@jev/core';
import type { ActionReceipt, BattleAction, TaskExecutor } from '@jev/core';
import { DemoAdapter, defaultCommanders } from '@jev/demo';

it('host-defined reactive actions execute without advancing HTN steps, and keep in-flight ownership', async () => {
  const host = new DemoAdapter();
  const query = host.legalActions.bind(host),
    execute = host.execute.bind(host);
  const receipts = new Map<string, ActionReceipt>();
  const stabilization: BattleAction = {
    id: 'stabilize-b1',
    unitId: 'b1',
    kind: 'stabilize',
    cost: 1,
    features: {},
  };
  host.legalActions = async (o, ids) => [
    ...(await query(o, ids)),
    ...(ids.includes('b1') ? [stabilization] : []),
  ];
  host.execute = async (envelope) => {
    if (envelope.action.kind !== 'stabilize') return execute(envelope);
    expect(envelope.stepId).toBeUndefined();
    const old = receipts.get(envelope.key);
    if (old) return old;
    host.inject({ id: envelope.key, kind: 'observation' }, () => {});
    const receipt: ActionReceipt = {
      key: envelope.key,
      actionId: stabilization.id,
      stateVersion: (await host.observe()).version,
      applied: true,
      detail: 'running',
      execution: 'running',
    };
    receipts.set(envelope.key, receipt);
    return receipt;
  };
  const network = new NetworkExecutor(defaultOperators());
  const executor: TaskExecutor = {
    update: (...args) => network.update(...args),
    options: (action, ...args) =>
      action.kind === 'stabilize' ? [{ score: 10000 }] : network.options(action, ...args),
  };
  const runtime = new CommandRuntime({
    adapter: host,
    store: new MemoryPlanStore(),
    commanders: defaultCommanders(),
    taskExecutor: executor,
  });
  await runtime.step();
  expect(runtime.state.receipts[0]?.actionId).toBe(stabilization.id);
  expect(
    Object.values(runtime.state.progress)
      .flatMap((p) => Object.values(p.execution?.steps ?? {}))
      .some((p) => p.actions.stabilize),
  ).toBe(false);
  await runtime.step();
  expect(runtime.state.receipts.filter((r) => r.actionId === stabilization.id)).toHaveLength(1);
});
