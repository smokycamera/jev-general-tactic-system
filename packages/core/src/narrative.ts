import type {
  Goal,
  NarrativeContext,
  NarrativeContextPolicy,
  NarrativeTrigger,
  Observation,
  RuntimePolicy,
} from './types.js';
import { assert, clone } from './util.js';
import { validateGoals } from './goals.js';

/** Normalize old and new configuration once, keeping host-specific message access outside the core. */
export function resolveNarrativePolicy(policy: RuntimePolicy): NarrativeContextPolicy {
  const value = policy.narrativeContext ?? {
    windowSize: policy.narrativeWindow,
    roles: policy.narrativeRoles,
    mode: policy.narrativeMode,
    trigger: ['battle-start', 'message-change', 'manual'],
  };
  assert(
    Number.isInteger(value.windowSize) && value.windowSize >= 0 && value.windowSize <= 100,
    'invalid narrative window',
  );
  assert(
    Array.isArray(value.roles) && value.roles.every((r) => typeof r === 'string'),
    'invalid narrative roles',
  );
  assert(['auto', 'manual', 'off'].includes(value.mode), 'invalid narrative mode');
  assert(
    Array.isArray(value.trigger) &&
      value.trigger.every((t) =>
        ['battle-start', 'message-change', 'decision', 'manual'].includes(t),
      ),
    'invalid narrative trigger',
  );
  return clone(value as NarrativeContextPolicy);
}
export function shouldScanNarrative(
  policy: NarrativeContextPolicy,
  trigger: NarrativeTrigger,
): boolean {
  if (policy.mode === 'off' || (trigger !== 'manual' && policy.mode !== 'auto')) return false;
  return (
    policy.trigger.includes(trigger) ||
    (trigger !== 'manual' && policy.trigger.includes('decision'))
  );
}

/** Whitelist hints; ignore fabricated unit state and other model output fields. */
export function validateNarrativeContext(
  value: Goal[] | NarrativeContext,
  observation: Observation,
): NarrativeContext {
  const input = Array.isArray(value) ? { goals: value } : value;
  assert(input && Array.isArray(input.goals) && input.goals.length <= 20, 'invalid context goals');
  const goals = input.goals.map((g) => ({ ...g, source: 'narrative' as const }));
  validateGoals(goals, observation);
  // A hidden/eliminated side may still own an explicit host goal.
  const sides = new Set([
    observation.activeSide,
    ...observation.units.map((u) => u.side),
    ...observation.goals.map((g) => g.side),
  ]);
  assert(
    goals.every((g) => sides.has(g.side)),
    'unknown goal side',
  );
  const result: NarrativeContext = { goals };
  for (const key of ['battleType', 'summary'] as const)
    if (input[key] !== undefined) {
      assert(typeof input[key] === 'string' && input[key]!.length <= 2000, 'invalid context text');
      result[key] = input[key];
    }
  if (input.environment !== undefined) {
    assert(
      Array.isArray(input.environment) &&
        input.environment.length <= 20 &&
        input.environment.every((s) => typeof s === 'string' && s.length <= 200),
      'invalid context environment',
    );
    result.environment = [...input.environment];
  }
  return result;
}
