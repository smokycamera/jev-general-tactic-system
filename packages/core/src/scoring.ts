import type {
  BattleAction,
  Candidate,
  Coordinator,
  EvaluationContext,
  Evaluator,
  Selector,
  TaskMethod,
} from './types.js';
import type { StyleDimensionRegistry } from './registry.js';
import { distance } from './util.js';
export const defaultEvaluator: Evaluator = {
  id: 'local-evaluator',
  evaluate(action, c) {
    const f = action.features;
    let utility = (f.objective ?? 0) * 6 + (f.damage ?? 0) * 5 + (f.initiative ?? 0) * 1.5;
    let risk = f.risk ?? 0;
    if (c.profile.factors.includes('terrain')) utility += (f.cover ?? 0) * 1.2;
    if (c.profile.factors.includes('role'))
      utility +=
        c.assignment?.role === 'support'
          ? (f.fire ?? 0) * 1.5
          : c.assignment?.role === 'flank'
            ? (f.flank ?? 0) * 1.5
            : 0;
    if (c.profile.factors.includes('phase')) utility += (f.objective ?? 0) * 0.6;
    if (c.profile.enemyResponses > 0) {
      const responses = [f.counterfire ?? risk, f.encirclement ?? risk, f.supplyRisk ?? risk].slice(
        0,
        c.profile.enemyResponses,
      );
      risk += Math.max(0, ...responses) * 0.5;
    }
    if (c.profile.factors.includes('cross-group')) utility += (f.concentration ?? 0) * 0.8;
    if (action.kind === 'wait') utility -= 1.2;
    return {
      utility,
      risk: risk * 3,
      continuity: (f.objective ?? 0) * ((c.commander.style.focus ?? 50) / 100),
    };
  },
};
export const defaultSelector: Selector = {
  select(candidates) {
    return [...candidates].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))[0];
  },
};
export const defaultCoordinator: Coordinator = {
  filter(actions, context) {
    const ids = new Set<string>();
    return actions.filter((a) => {
      if (ids.has(a.id)) return false;
      ids.add(a.id);
      const assignment = context.assignments.find((r) => r.unitId === a.unitId);
      return !assignment || assignment.committed || ['wait', 'defend', 'recon'].includes(a.kind);
    });
  },
};
export function scoreAction(
  action: BattleAction,
  c: EvaluationContext,
  method: TaskMethod,
  styles: StyleDimensionRegistry,
  evaluators: Evaluator[],
): Candidate {
  const features = { ...action.features };
  const unit = c.observation.units.find((u) => u.id === action.unitId);
  if (c.goal.target && unit) {
    const before = Math.min(30, distance(c.observation.map, unit.location, c.goal.target));
    const after = Math.min(
      30,
      distance(c.observation.map, action.destination ?? unit.location, c.goal.target),
    );
    features.objective =
      action.kind === 'move'
        ? (before - after) * 0.5
        : unit.location === c.goal.target
          ? 1
          : action.kind === 'attack'
            ? 0.35
            : 0;
    if (c.goal.kind === 'withdraw') {
      features.retreat = before - after;
      if (action.kind === 'attack') features.objective = -0.2;
    }
    if (c.goal.kind === 'defend' && unit.location === c.goal.target) features.hold = 1;
  }
  const evaluated = { ...action, features };
  const base = evaluators.reduce(
    (s, e) => {
      const v = e.evaluate(evaluated, c);
      return {
        utility: s.utility + v.utility,
        risk: s.risk + v.risk,
        continuity: s.continuity + v.continuity,
      };
    },
    { utility: 0, risk: 0, continuity: 0 },
  );
  const style = styles.score(features, c.commander.style);
  const utility = base.utility + method.actionBias(evaluated, c);
  const total = utility - base.risk + base.continuity + style;
  return {
    id: action.id,
    label: `${action.unitId} ${action.kind}`,
    features,
    ...base,
    utility,
    style,
    total,
    action,
  };
}
