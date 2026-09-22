import type { Goal, NarrativeMessage, Observation } from './types.js';
import { assert, clone } from './util.js';
const priority = { default: 0, narrative: 1, host: 2, user: 3 };
export function validateGoals(goals: Goal[], observation?: Observation): void {
  for (const goal of goals) {
    assert(
      typeof goal.id === 'string' && goal.id.length > 0 && goal.id.length < 160,
      'invalid goal id',
    );
    assert(typeof goal.title === 'string' && goal.title.length <= 2000, 'invalid goal title');
    assert(
      typeof goal.kind === 'string' && /^[a-z][a-z0-9_.-]*$/i.test(goal.kind),
      'invalid goal kind',
    );
    assert(Object.hasOwn(priority, goal.source), 'invalid goal source');
    assert(Number.isInteger(goal.version) && goal.version >= 0, 'invalid goal version');
    assert(
      Number.isFinite(goal.priority) && goal.priority >= 0 && goal.priority <= 100,
      'invalid priority',
    );
    assert(typeof goal.side === 'string' && goal.side.length > 0, 'invalid goal side');
    if (goal.target && observation)
      assert(
        observation.map.locations.some((l) => l.id === goal.target),
        'unknown goal location',
      );
    if (['capture', 'defend', 'withdraw', 'recon'].includes(goal.kind))
      assert(goal.target, 'goal requires target');
  }
}
/** A lower-priority source cannot overwrite any explicit goal with the same semantic id. */
export function mergeGoals(existing: Goal[], incoming: Goal[]): Goal[] {
  validateGoals(incoming);
  const result = new Map(existing.map((g) => [`${g.side}:${g.id}`, clone(g)]));
  for (const goal of incoming) {
    const key = `${goal.side}:${goal.id}`;
    const old = result.get(key);
    if (
      !old ||
      priority[goal.source] > priority[old.source] ||
      (priority[goal.source] === priority[old.source] && goal.version > old.version)
    )
      result.set(key, clone(goal));
  }
  return [...result.values()].sort(
    (a, b) =>
      priority[b.source] - priority[a.source] ||
      b.priority - a.priority ||
      a.id.localeCompare(b.id),
  );
}
export function narrativeWindow(
  messages: NarrativeMessage[],
  count = 6,
  roles = ['assistant'],
): NarrativeMessage[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  return messages.filter((m) => m.completed && roles.includes(m.role)).slice(-count);
}
