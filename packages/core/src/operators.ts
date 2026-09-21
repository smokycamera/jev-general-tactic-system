import type { BattleAction, EvaluationContext, Unit } from './types.js';
import type {
  ExecutionContext,
  HtnMethod,
  PlanningContext,
  TaskOperator,
  TaskSpec,
} from './execution-types.js';
import { Registry } from './registry.js';
import { defaultCapabilityResolver, isAction, visibleEnemies } from './capabilities.js';
import { distance, stable } from './util.js';

export function taskUnits(c: PlanningContext): Unit[] {
  return c.evaluation.observation.units.filter(
    (u) => c.spec.unitIds.includes(u.id) && u.hp > 0 && !u.tags.includes('evacuated'),
  );
}
export function targetFor(c: EvaluationContext): string | undefined {
  if (c.goal.target) return c.goal.target;
  const own = c.observation.units.find((u) => c.commander.unitIds.includes(u.id) && u.hp > 0);
  return (
    visibleEnemies(c.observation, c.commander.side).sort(
      (a, b) =>
        (own
          ? distance(c.observation.map, own.location, a.location) -
            distance(c.observation.map, own.location, b.location)
          : 0) || a.id.localeCompare(b.id),
    )[0]?.location ?? own?.location
  );
}
export function actionIs(a: BattleAction, c: PlanningContext, kind: string): boolean {
  return isAction(c.capabilities, kind, a.kind);
}
function radius(c: PlanningContext) {
  return Number(c.spec.data?.radius ?? 0);
}
function atDestination(c: PlanningContext): boolean {
  return (
    !!c.spec.target &&
    taskUnits(c).every(
      (u) => distance(c.evaluation.observation.map, u.location, c.spec.target!) <= radius(c),
    )
  );
}
function movementScore(a: BattleAction, c: ExecutionContext): number | undefined {
  const o = c.evaluation.observation;
  const unit = o.units.find((u) => u.id === a.unitId);
  if (!unit || !c.spec.target) return undefined;
  if (actionIs(a, c, 'move') && a.destination) {
    const before = distance(o.map, unit.location, c.spec.target);
    const after = distance(o.map, a.destination, c.spec.target);
    if (!Number.isFinite(after)) return undefined;
    // Require measurable route progress; avoids lateral oscillation from style scores.
    if (after >= before) return undefined;
    return 12 + (Math.min(before, 100) - after) * 6;
  }
  // Clear a blocked route or react to immediate contact without changing the destination.
  if (actionIs(a, c, 'attack') && c.spec.data?.peaceful !== true) return 1;
  if (actionIs(a, c, 'wait') || actionIs(a, c, 'defend')) return -12;
  return undefined;
}
function signature(c: ExecutionContext): string {
  return stable({
    units: taskUnits(c).map((u) => [u.id, u.location]),
    actions: Object.entries(c.progress.actions).filter(
      ([kind]) => !['wait', 'defend'].includes(kind),
    ),
  });
}
function repairMove(c: ExecutionContext): TaskSpec | undefined {
  const o = c.evaluation.observation;
  const own = taskUnits(c);
  if (!own.length) return undefined;
  // Keep the mission and other branches; choose a reachable nearby staging location.
  const old = o.map.locations.find((l) => l.id === c.spec.target);
  const candidates = o.map.locations.filter(
    (l) =>
      !l.blocked &&
      own.every((u) => Number.isFinite(distance(o.map, u.location, l.id))) &&
      l.id !== c.spec.target,
  );
  const pick = candidates.sort(
    (a, b) =>
      (old ? Math.hypot(a.x - old.x, a.y - old.y) - Math.hypot(b.x - old.x, b.y - old.y) : 0) ||
      b.cover - a.cover ||
      a.id.localeCompare(b.id),
  )[0];
  if (!pick) return undefined;
  return { ...c.spec, target: pick.id, data: { ...c.spec.data, radius: 1 } };
}
export function defaultOperators(): Registry<TaskOperator> {
  const r = new Registry<TaskOperator>();
  const move: TaskOperator = {
    id: 'move',
    requirements: ['movement'],
    canPlan: (c) =>
      !!c.spec.target &&
      taskUnits(c).length > 0 &&
      taskUnits(c).every((u) =>
        Number.isFinite(distance(c.evaluation.observation.map, u.location, c.spec.target!)),
      ),
    predict: (c) => ({ ['at:' + c.spec.id]: c.spec.target ?? '' }),
    observe: (c) =>
      taskUnits(c).length === 0 ? 'failed' : atDestination(c) ? 'succeeded' : 'running',
    score: movementScore,
    signature,
    repair: repairMove,
  };
  r.register(move);
  r.register({ ...move, id: 'rally' });
  r.register({
    ...move,
    id: 'withdraw',
    score: (a, c) => {
      const value = movementScore(a, c);
      if (value === undefined) return undefined;
      return value + (actionIs(a, c, 'move') ? (a.features.safety ?? 0) * 3 : -4);
    },
  });
  const engage: TaskOperator = {
    id: 'engage',
    canPlan: (c) =>
      taskUnits(c).length > 0 &&
      (!c.spec.data?.requiresFact || c.facts[String(c.spec.data.requiresFact)] === true),
    predict: () => ({ engaged: true }),
    observe: (c) => {
      if (!taskUnits(c).length) return 'failed';
      const { observation: o, goal } = c.evaluation;
      if (
        o.ended ||
        (goal.kind === 'capture' &&
          goal.target &&
          taskUnits(c).some((u) => u.location === goal.target))
      )
        return 'succeeded';
      if (c.capabilities.fullyObservable && visibleEnemies(o, goal.side).length === 0)
        return 'succeeded';
      return 'running';
    },
    score: (a, c) => {
      if (actionIs(a, c, 'attack')) return 8;
      return movementScore(a, c);
    },
    signature,
  };
  r.register(engage);
  r.register({
    ...engage,
    id: 'fire',
    requirements: ['ranged-fire'],
    canPlan: (c) =>
      taskUnits(c).some((u) => u.range > 1 && (!c.capabilities.mechanisms.ammo || u.ammo > 0)),
    predict: () => ({ firePrepared: true }),
    observe: (c) =>
      (c.progress.actions.attack ?? 0) > 0
        ? 'succeeded'
        : taskUnits(c).some((u) => u.range > 1 && (!c.capabilities.mechanisms.ammo || u.ammo > 0))
          ? 'running'
          : 'failed',
    score: (a, c) => {
      const unit = taskUnits(c).find((u) => u.id === a.unitId);
      if (!unit || unit.range <= 1) return undefined;
      if (actionIs(a, c, 'attack')) return 40;
      return engage.score(a, c);
    },
  });
  r.register({
    ...engage,
    id: 'fix',
    predict: () => ({ fixingEstablished: true }),
    observe: (c) =>
      (c.progress.actions.attack ?? 0) > 0
        ? 'succeeded'
        : taskUnits(c).length
          ? 'running'
          : 'failed',
  });
  r.register({
    ...engage,
    id: 'probe',
    observe: (c) =>
      (c.progress.actions.attack ?? 0) > 0 || atDestination(c) ? 'succeeded' : 'running',
  });
  r.register({
    ...engage,
    id: 'hold',
    watchdog: false,
    predict: () => ({ positionSecured: true }),
    observe: (c) => {
      if (!taskUnits(c).length) return 'failed';
      if (c.spec.data?.once === true && atDestination(c) && (c.progress.actions.defend ?? 0) > 0)
        return 'succeeded';
      return c.evaluation.observation.ended ? 'succeeded' : 'running';
    },
    score: (a, c) => {
      if (actionIs(a, c, 'attack')) return 8;
      if (atDestination(c) && actionIs(a, c, 'defend')) return 5;
      return movementScore(a, c);
    },
  });
  r.register({
    ...r.get('hold'),
    id: 'cover',
    observe: (c) =>
      (c.progress.actions.attack ?? 0) + (c.progress.actions.defend ?? 0) > 0
        ? 'succeeded'
        : taskUnits(c).length
          ? 'running'
          : 'failed',
    score: (a, c) =>
      actionIs(a, c, 'attack')
        ? 10
        : actionIs(a, c, 'defend')
          ? 8
          : actionIs(a, c, 'wait')
            ? -5
            : undefined,
    watchdog: true,
  });
  r.register({
    ...r.get('hold'),
    id: 'contact',
    observe: (c) => {
      const o = c.evaluation.observation;
      return taskUnits(c).some((u) =>
        visibleEnemies(o, u.side).some(
          (e) => distance(o.map, u.location, e.location) <= Math.max(u.range, e.range),
        ),
      )
        ? 'succeeded'
        : 'running';
    },
  });
  r.register({
    ...r.get('hold'),
    id: 'delay',
    observe: (c) =>
      (c.progress.actions.attack ?? 0) > 0 ||
      c.evaluation.assessment.threat > 1.25 ||
      c.evaluation.observation.turn - c.progress.enteredTurn >= 2
        ? 'succeeded'
        : 'running',
  });
  r.register({
    ...engage,
    id: 'commit',
    observe: engage.observe,
    score: (a, c) =>
      c.evaluation.assessment.advantage < Number(c.spec.data?.threshold ?? -0.15) ||
      c.evaluation.observation.turn - c.progress.enteredTurn >= Number(c.spec.data?.delay ?? 2)
        ? engage.score(a, c)
        : actionIs(a, c, 'defend') || actionIs(a, c, 'wait')
          ? -5
          : undefined,
    watchdog: false,
  });
  for (const [id, capability] of [
    ['recon', 'recon'],
    ['smoke', 'smoke'],
    ['suppress', 'suppression'],
    ['conceal', 'stealth'],
  ] as const) {
    r.register({
      id,
      requirements: [capability],
      canPlan: (c) => taskUnits(c).length > 0,
      predict: () => ({ [id + 'Ready']: true }),
      observe: (c) =>
        (c.progress.actions[id] ?? 0) > 0
          ? 'succeeded'
          : taskUnits(c).length
            ? 'running'
            : 'failed',
      score: (a, c) => (actionIs(a, c, id) ? 20 : undefined),
      signature,
    });
  }
  return r;
}
/** Alternative decompositions are registered independently of the tactical catalogue. */
export function defaultHtnMethods(): Registry<HtnMethod> {
  return new Registry<HtnMethod>()
    .register({
      id: 'approach-and-engage',
      task: 'combat',
      requirements: ['movement'],
      expand: (c) => [
        { ...c.spec, id: 'approach', task: 'move', after: [], data: { ...c.spec.data, radius: 1 } },
        { ...c.spec, id: 'engage', task: 'engage', after: ['approach'] },
      ],
    })
    .register({
      id: 'engage-in-place',
      task: 'combat',
      expand: (c) => [{ ...c.spec, id: 'engage', task: 'engage', after: [] }],
    });
}
export function makeSpec(
  id: string,
  task: string,
  units: string[],
  after: string[] = [],
  target?: string,
): TaskSpec {
  return { id, task, unitIds: units, after, ...(target ? { target } : {}) };
}
export function capabilitiesFor(context: EvaluationContext) {
  return context.capabilities ?? defaultCapabilityResolver.resolve(context.observation);
}
