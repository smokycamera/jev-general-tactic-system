import type {
  Allocator,
  Assessment,
  BattlePlan,
  CapabilityProfile,
  Commander,
  Condition,
  EvaluationContext,
  Goal,
  Observation,
  PlanPatch,
  Revision,
  Task,
  TaskProgress,
} from './types.js';
import { assert, clamp, clone, distance, stable } from './util.js';
export function assess(o: Observation, side: string, unitIds?: string[]): Assessment {
  const own = o.units.filter(
    (u) => u.side === side && u.hp > 0 && (!unitIds || unitIds.includes(u.id)),
  );
  const nearby = (u: Observation['units'][number]) =>
    !unitIds ||
    own.some((a) => distance(o.map, a.location, u.location) <= Math.max(a.range, u.range) + 3);
  const strength = (friendly: boolean) =>
    o.units
      .filter(
        (u) => (u.side === side) === friendly && u.hp > 0 && u.side !== 'neutral' && nearby(u),
      )
      .reduce(
        (s, u) =>
          s +
          (((u.hp / u.maxHp) * u.attack) / Math.max(1, u.attackInterval ?? 1)) *
            (o.capabilities?.mechanisms?.ammo && u.range > 1 && u.ammo <= 0 ? 0 : 1),
        0,
      );
  const friendlyStrength = strength(true),
    enemyStrength = strength(false);
  return {
    friendlyStrength,
    enemyStrength,
    advantage: (friendlyStrength - enemyStrength) / Math.max(1, friendlyStrength + enemyStrength),
    threat: enemyStrength / Math.max(1, friendlyStrength),
    uncertainty: o.units.some((u) => u.tags.includes('uncertain')) ? 0.7 : 0.2,
    blocked: o.map.locations.filter((l) => l.blocked).map((l) => l.id),
  };
}
export function conditionMet(
  condition: Condition,
  o: Observation,
  task: Task,
  progress: TaskProgress,
  goal: Goal,
): boolean {
  const units = o.units.filter((u) => task.unitIds.includes(u.id) && u.hp > 0);
  const enemies = o.units.filter((u) => u.side !== goal.side && u.side !== 'neutral' && u.hp > 0);
  switch (condition.kind) {
    case 'always':
      return true;
    case 'turns':
      return o.turn - progress.enteredTurn >= (condition.value ?? 1);
    case 'low-strength':
      return (
        units.length === 0 ||
        units.reduce((s, u) => s + u.hp, 0) / units.reduce((s, u) => s + u.maxHp, 0) <
          (condition.value ?? 0.3)
      );
    case 'no-enemy':
      return o.ended || (o.capabilities?.fullyObservable === true && enemies.length === 0);
    case 'at-target':
      return !!goal.target && units.some((u) => u.location === goal.target);
    case 'enemy-near':
      return units.some((u) =>
        enemies.some((e) => distance(o.map, u.location, e.location) <= (condition.value ?? 2)),
      );
    case 'support-ready':
      return units.some(
        (u) => u.range > 1 && u.ap > 0 && (!o.capabilities?.mechanisms?.ammo || u.ammo > 0),
      );
  }
}
export function advanceProgress(
  plan: BattlePlan,
  progress: Record<string, TaskProgress>,
  o: Observation,
): Record<string, TaskProgress> {
  const result = clone(progress);
  for (const task of plan.tasks) {
    const p = result[task.id];
    if (!p || p.status !== 'active') continue;
    if (task.network) {
      if (o.ended) p.status = 'completed';
      continue;
    }
    const goal = plan.goals.find((g) => g.id === task.goalId && g.side === task.side);
    if (!goal) continue;
    const phase = task.phases[p.phase];
    if (o.ended) {
      p.status = 'completed';
      continue;
    }
    if (
      phase &&
      conditionMet(phase.complete, o, task, p, goal) &&
      p.phase < task.phases.length - 1
    ) {
      const next = task.phases[p.phase + 1]!;
      if (conditionMet(next.enter, o, task, p, goal)) {
        p.phase++;
        p.enteredTurn = o.turn;
      }
    }
  }
  return result;
}
export function applyPlanPatch(
  plan: BattlePlan,
  progress: Record<string, TaskProgress>,
  patch: PlanPatch,
  turn: number,
): { plan: BattlePlan; progress: Record<string, TaskProgress>; revision: Revision } {
  assert(plan.version === patch.baseVersion, 'plan version conflict');
  const next = clone(plan),
    states = clone(progress);
  const cancelled: string[] = [],
    added: string[] = [];
  if (patch.lock) {
    const task = next.tasks.find((t) => t.id === patch.lock!.taskId);
    assert(task, 'unknown task');
    task.locked = patch.lock.locked;
  }
  if (patch.replaceTasks) {
    const old = next.tasks.filter(
      (t) => t.level === 'tactics' && patch.scope.includes(t.commanderId),
    );
    for (const t of old) {
      assert(!t.locked || patch.source === 'user', 'locked task');
      const p = states[t.id];
      if (p && p.status !== 'completed') {
        p.status = 'cancelled';
        cancelled.push(t.id);
      }
    }
    next.tasks = next.tasks.filter(
      (t) => t.level !== 'tactics' || !patch.scope.includes(t.commanderId),
    );
    for (const task of patch.replaceTasks) {
      assert(patch.scope.includes(task.commanderId), 'task outside patch scope');
      assert(
        !next.tasks.some((t) => t.id === task.id) && !Object.hasOwn(states, task.id),
        'duplicate task id',
      );
      next.tasks.push(clone(task));
      states[task.id] = {
        taskId: task.id,
        status: 'active',
        phase: 0,
        enteredTurn: turn,
        actions: 0,
      };
      added.push(task.id);
    }
  }
  next.version++;
  for (const task of next.tasks) if (added.includes(task.id)) task.planVersion = next.version;
  return {
    plan: next,
    progress: states,
    revision: {
      from: plan.version,
      to: next.version,
      source: patch.source,
      reason: patch.reason,
      events: patch.events,
      scope: patch.scope,
      cancelled,
      added,
    },
  };
}
export const defaultAllocator: Allocator = {
  allocate(o, commanders, plan, progress, profiles) {
    const result = [];
    for (const commander of commanders) {
      const task = plan.tasks.find((t) => t.commanderId === commander.id && t.level === 'tactics');
      if (!task) continue;
      const profile = profiles[commander.ability]!;
      if (task.network) {
        for (const unitId of task.unitIds) {
          const step = task.network.steps.find(
            (s) =>
              s.unitIds.includes(unitId) &&
              progress[task.id]?.execution?.steps[s.id]?.status === 'running',
          );
          result.push({ unitId, taskId: task.id, role: step?.task ?? 'waiting', committed: true });
        }
        continue;
      }
      const phase = task.phases[progress[task.id]?.phase ?? 0];
      const units = o.units
        .filter((u) => commander.unitIds.includes(u.id) && u.side === commander.side && u.hp > 0)
        .sort((a, b) => b.range - a.range || a.id.localeCompare(b.id));
      const reserveCount =
        profile.coordination >= 2 && units.length >= 3
          ? Math.max(0, Math.round((units.length * (100 - (commander.style.reserve ?? 50))) / 250))
          : 0;
      for (let i = 0; i < units.length; i++) {
        const u = units[i]!;
        const last = i >= units.length - reserveCount;
        const role =
          profile.coordination === 0
            ? 'independent'
            : last
              ? 'reserve'
              : u.range > 1
                ? 'support'
                : (phase?.roles[i % (phase.roles.length || 1)] ?? 'assault');
        const committed =
          role !== 'reserve' ||
          o.turn > 2 + (100 - (commander.style.reserve ?? 50)) / 20 ||
          assess(o, commander.side).advantage < -0.25;
        result.push({ unitId: u.id, taskId: task.id, role, committed });
      }
    }
    return result;
  },
};
export function goalFor(commander: Commander, goals: Goal[]): Goal {
  return (
    goals.find((g) => g.side === commander.side) ?? {
      id: `default-${commander.side}`,
      title: '击退对手',
      kind: 'eliminate',
      priority: 1,
      source: 'default',
      version: 0,
      side: commander.side,
    }
  );
}
export function evaluationContext(
  o: Observation,
  c: Commander,
  p: CapabilityProfile,
  goals: Goal[],
): EvaluationContext {
  return {
    observation: o,
    commander: c,
    profile: p,
    goal: goalFor(c, goals),
    assessment: assess(o, c.side, c.unitIds),
  };
}
export function taskFromMethod(
  id: string,
  c: Commander,
  goal: Goal,
  version: number,
  method: { id: string; family: string; phases: (context: EvaluationContext) => Task['phases'] },
  context: EvaluationContext,
  alternatives: string[],
): Task {
  return {
    id,
    side: c.side,
    parentId: `campaign-${c.id}`,
    level: 'tactics',
    commanderId: c.id,
    goalId: goal.id,
    doctrineId: method.id,
    family: method.family,
    unitIds: [...c.unitIds],
    planVersion: version,
    phases: method.phases(context),
    alternatives,
    ...(goal.target ? { region: goal.target } : {}),
    locked: false,
    resourceCommitment: clamp((c.style.reserve ?? 50) / 100),
    strengthAtCreation: context.observation.units
      .filter((u) => c.unitIds.includes(u.id))
      .reduce((s, u) => s + u.hp, 0),
    configurationKey: stable({ ability: c.ability, style: c.style, profile: context.profile }),
  };
}
