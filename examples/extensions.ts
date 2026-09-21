import {
  CommandRuntime,
  MemoryPlanStore,
  defaultDoctrines,
  defaultStyles,
  PROFILES,
} from '@jev/core';
import type { DecisionStage } from '@jev/core';
import { DemoAdapter, defaultCommanders } from '@jev/demo';
// Example: add a doctrine, style and stage without modifying the scheduler.
const doctrines = defaultDoctrines();
const base = doctrines.get('flank-breakthrough');
doctrines.register({
  ...base,
  id: 'rapid-raid',
  label: '快速袭扰',
  features: { ...base.features, mobility: 1 },
  score: (c) => (c.assessment.advantage > 0 ? 4 : 1),
});
const styles = defaultStyles().register({
  id: 'tempo',
  label: '节奏偏好',
  low: '稳步',
  high: '快速',
  effect: '提高机动收益',
  contribution: (features, value) => ((value - 50) / 50) * (features.mobility ?? 0),
});
const audit: DecisionStage = {
  id: 'candidate-audit',
  version: '1.0.0',
  dependencies: ['select'],
  inputs: ['selected'],
  outputs: [],
  capabilities: [],
  budgetMs: 20,
  config: {},
  run: async (context) => {
    context.trace.push(`selected:${context.selected?.id ?? 'none'}`);
  },
};
export const runtime = new CommandRuntime({
  adapter: new DemoAdapter(),
  store: new MemoryPlanStore(),
  commanders: defaultCommanders(),
  doctrines,
  styles,
  profiles: { ...PROFILES, skilled: { ...PROFILES.skilled!, candidateLimit: 5 } },
  extraStages: [audit],
});
