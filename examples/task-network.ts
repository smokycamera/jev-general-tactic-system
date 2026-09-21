import {
  CommandRuntime,
  MemoryPlanStore,
  defaultDoctrines,
  defaultOperators,
  defaultHtnMethods,
  defaultModifiers,
  makeSpec,
  isAction,
} from '@jev/core';
import type { BattleAdapter, Commander } from '@jev/core';

/** A game's optional entrenchment mechanic, with a complete fallback when absent. */
export function createFortificationRuntime(adapter: BattleAdapter, commanders: Commander[]) {
  const operators = defaultOperators().register({
    id: 'entrench',
    requirements: ['entrenchment'],
    canPlan: (c) => c.spec.unitIds.length > 0,
    predict: () => ({ fortified: true }),
    observe: (c) => ((c.progress.actions.entrench ?? 0) > 0 ? 'succeeded' : 'running'),
    score: (action, c) => (isAction(c.capabilities, 'entrench', action.kind) ? 30 : undefined),
  });
  const methods = defaultHtnMethods()
    .register({
      id: 'fortify-then-hold',
      task: 'prepare-position',
      requirements: ['entrenchment'],
      expand: (c) => [
        { ...c.spec, id: 'dig', task: 'entrench', after: [] },
        {
          ...c.spec,
          id: 'guard',
          task: 'hold',
          after: ['dig'],
          data: { requiresFact: 'fortified', radius: 1 },
        },
      ],
    })
    .register({
      id: 'ordinary-hold',
      task: 'prepare-position',
      expand: (c) => [{ ...c.spec, id: 'guard', task: 'hold', after: [], data: { radius: 1 } }],
    });
  const doctrines = defaultDoctrines();
  doctrines.register({
    ...doctrines.get('hold-position'),
    id: 'fortified-position',
    label: '构筑防御阵地',
    decompose: (c) => [
      makeSpec('position', 'prepare-position', c.commander.unitIds, [], c.goal.target),
    ],
  });
  const modifiers = defaultModifiers().register({
    id: 'reserve-passage',
    label: '预留共用通路',
    apply: (specs) =>
      specs.map((s) => ({ ...s, resources: [...(s.resources ?? []), 'passage:west'] })),
  });
  return new CommandRuntime({
    adapter,
    commanders,
    store: new MemoryPlanStore(),
    operators,
    methods,
    doctrines,
    modifiers,
  });
}

// The host may declare mechanisms.entrenchment=true and actionKinds.entrench=['dig-in'].
// Without that declaration, the same doctrine decomposes to ordinary holding.
// The host must still provide legalActions and authoritative execution receipts.
