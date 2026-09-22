import type { EvaluationContext, Features, TaskMethod } from './types.js';
import type { TacticalModifier, TacticCategory, TaskSpec } from './execution-types.js';
import { DoctrineRegistry, Registry } from './registry.js';
import { supports, visibleEnemies } from './capabilities.js';
import { capabilitiesFor, makeSpec, targetFor } from './operators.js';
import { createDistanceLookup } from './util.js';
import { resolveTarget } from './targeting.js';
const geometry = new WeakMap<EvaluationContext, ReturnType<typeof createDistanceLookup>>();
function tacticalDistance(c: EvaluationContext, from: string, to: string): number {
  let lookup = geometry.get(c);
  if (!lookup) {
    lookup = createDistanceLookup(c.observation.map);
    geometry.set(c, lookup);
  }
  return lookup(from, to);
}

export function defaultCategories(): Registry<TacticCategory> {
  const r = new Registry<TacticCategory>();
  for (const [id, label, parentId] of [
    ['attack', '进攻'],
    ['defend', '防御'],
    ['withdraw', '退却作战'],
    ['security', '侦察与警戒'],
    ['exploit', '反击与战果利用'],
    ['breakthrough', '突破', 'attack'],
    ['flank-attack', '侧翼攻击', 'attack'],
    ['envelopment', '包围', 'attack'],
    ['delay', '迟滞', 'withdraw'],
  ])
    r.register({ id: id!, label: label!, ...(parentId ? { parentId } : {}) });
  return r;
}
function own(c: EvaluationContext) {
  return c.observation.units.filter(
    (u) => c.commander.unitIds.includes(u.id) && u.hp > 0 && !u.tags.includes('evacuated'),
  );
}
export function rallyPoint(c: EvaluationContext): string | undefined {
  const units = own(c);
  return [...units].sort(
    (a, b) =>
      units.reduce((n, u) => n + tacticalDistance(c, u.location, a.location), 0) -
        units.reduce((n, u) => n + tacticalDistance(c, u.location, b.location), 0) ||
      a.id.localeCompare(b.id),
  )[0]?.location;
}
/** Lateral directions are relative to the approach vector, not a hard-coded map axis. */
export function flankPoint(
  c: EvaluationContext,
  direction: 'left' | 'right',
  rejected: string[] = [],
): string | undefined {
  const origin = c.observation.map.locations.find((l) => l.id === rallyPoint(c));
  const target = c.observation.map.locations.find((l) => l.id === targetFor(c));
  if (!origin || !target) return undefined;
  const dx = target.x - origin.x,
    dy = target.y - origin.y,
    sign = direction === 'left' ? 1 : -1;
  const units = own(c);
  return c.observation.map.locations
    .filter(
      (l) =>
        !l.blocked &&
        !rejected.includes(l.id) &&
        l.id !== origin.id &&
        l.id !== target.id &&
        sign * (dx * (l.y - origin.y) - dy * (l.x - origin.x)) > 0 &&
        units.every((u) => Number.isFinite(tacticalDistance(c, u.location, l.id))),
    )
    .sort((a, b) => {
      const score = (l: typeof a) =>
        Math.abs(tacticalDistance(c, origin.id, l.id) - tacticalDistance(c, l.id, target.id)) -
        l.cover;
      return score(a) - score(b) || a.id.localeCompare(b.id);
    })[0]?.id;
}
function sequence(specs: TaskSpec[]): TaskSpec[] {
  return specs.map((s, i) => ({ ...s, after: i ? [specs[i - 1]!.id] : [] }));
}
function movement(id: string, units: string[], target: string | undefined, radius = 1): TaskSpec {
  return { ...makeSpec(id, 'move', units, [], target), data: { radius } };
}
type Pattern =
  | 'search'
  | 'frontal'
  | 'breakthrough'
  | 'sector'
  | 'flank'
  | 'single'
  | 'double'
  | 'stealth'
  | 'turn'
  | 'surprise'
  | 'fire'
  | 'feint'
  | 'hold'
  | 'depth'
  | 'elastic'
  | 'mobile'
  | 'strongpoint'
  | 'ambush'
  | 'delay'
  | 'fighting-delay'
  | 'fighting-withdrawal'
  | 'bounding'
  | 'disengage'
  | 'breakout'
  | 'recon'
  | 'probe'
  | 'recon-force'
  | 'screen'
  | 'cover'
  | 'counterattack'
  | 'counteroffensive'
  | 'exploit'
  | 'pursuit';
interface Definition {
  id: string;
  label: string;
  family: string;
  pattern: Pattern;
  category?: string;
  requirements?: string[];
  minUnits?: number;
  features?: Features;
  base?: number;
}
const DEFINITIONS: Definition[] = [
  {
    id: 'search-contact',
    label: '搜索接触',
    family: 'security',
    pattern: 'search',
    requirements: ['movement'],
    features: { mobility: 1 },
    base: 5,
  },
  {
    id: 'frontal-attack',
    label: '正面攻击',
    family: 'attack',
    pattern: 'frontal',
    features: { initiative: 1 },
  },
  {
    id: 'central-breakthrough',
    label: '中央突破',
    family: 'attack',
    category: 'breakthrough',
    pattern: 'breakthrough',
    features: { concentration: 1, initiative: 1, flank: -1 },
    base: 2.1,
  },
  {
    id: 'sector-breakthrough',
    label: '局部重点突破',
    family: 'attack',
    category: 'breakthrough',
    pattern: 'sector',
    features: { concentration: 1.3, fire: 0.5 },
    base: 1.7,
  },
  {
    id: 'flank-breakthrough',
    label: '侧翼攻击',
    family: 'attack',
    category: 'flank-attack',
    pattern: 'flank',
    requirements: ['movement', 'flanking'],
    features: { flank: 1, mobility: 1 },
    base: 2,
  },
  {
    id: 'single-envelopment',
    label: '单翼包围',
    family: 'attack',
    category: 'envelopment',
    pattern: 'single',
    requirements: ['movement', 'flanking'],
    minUnits: 2,
    features: { flank: 1, concentration: 0.8 },
  },
  {
    id: 'envelopment',
    label: '双翼包围',
    family: 'attack',
    category: 'envelopment',
    pattern: 'double',
    requirements: ['movement', 'flanking'],
    minUnits: 3,
    features: { flank: 1, concentration: 1, patience: 0.6 },
  },
  {
    id: 'infiltration',
    label: '渗透',
    family: 'attack',
    pattern: 'stealth',
    requirements: ['stealth', 'movement'],
    features: { mobility: 1, risk: 0.3 },
  },
  {
    id: 'turning-movement',
    label: '迂回',
    family: 'attack',
    pattern: 'turn',
    requirements: ['movement', 'flanking'],
    features: { flank: 1.2, mobility: 1, patience: 0.5 },
  },
  {
    id: 'surprise-attack',
    label: '突袭',
    family: 'attack',
    pattern: 'surprise',
    requirements: ['stealth'],
    features: { initiative: 1.3, fire: 0.4 },
  },
  {
    id: 'fire-then-assault',
    label: '火力准备后突击',
    family: 'attack',
    pattern: 'fire',
    requirements: ['ranged-fire'],
    features: { fire: 1.5, concentration: 0.5 },
  },
  {
    id: 'feint-fix',
    label: '佯攻牵制',
    family: 'attack',
    pattern: 'feint',
    features: { feint: 1.5, safety: 0.4 },
  },
  {
    id: 'hold-position',
    label: '固守',
    family: 'defend',
    pattern: 'hold',
    features: { hold: 1, fire: 0.5 },
    base: 2,
  },
  {
    id: 'defense-in-depth',
    label: '纵深防御',
    family: 'defend',
    pattern: 'depth',
    requirements: ['movement'],
    features: { hold: 0.6, safety: 0.8, patience: 0.5 },
  },
  {
    id: 'elastic-defense',
    label: '弹性防御',
    family: 'defend',
    pattern: 'elastic',
    requirements: ['movement'],
    features: { safety: 1, mobility: 0.8 },
  },
  {
    id: 'mobile-defense',
    label: '机动防御',
    family: 'defend',
    pattern: 'mobile',
    requirements: ['movement'],
    features: { mobility: 1, concentration: 0.8 },
  },
  {
    id: 'strongpoint-defense',
    label: '据点防御',
    family: 'defend',
    pattern: 'strongpoint',
    requirements: ['terrain'],
    features: { hold: 1.4, fire: 0.7 },
  },
  {
    id: 'ambush-defense',
    label: '伏击防御',
    family: 'defend',
    pattern: 'ambush',
    requirements: ['stealth'],
    features: { fire: 1, patience: 1 },
  },
  {
    id: 'delay-lines',
    label: '逐线迟滞',
    family: 'withdraw',
    category: 'delay',
    pattern: 'delay',
    requirements: ['movement'],
    features: { safety: 0.7, fire: 0.5 },
  },
  {
    id: 'fighting-delay',
    label: '战斗迟滞',
    family: 'withdraw',
    category: 'delay',
    pattern: 'fighting-delay',
    features: { fire: 0.8, patience: 0.7 },
  },
  {
    id: 'fighting-withdrawal',
    label: '战斗撤退',
    family: 'withdraw',
    pattern: 'fighting-withdrawal',
    requirements: ['movement'],
    features: { safety: 1, fire: 0.6 },
  },
  {
    id: 'bounding-withdrawal',
    label: '交替掩护撤退',
    family: 'withdraw',
    pattern: 'bounding',
    requirements: ['movement'],
    minUnits: 2,
    features: { safety: 1, mobility: 0.6, patience: 0.6 },
    base: 2.1,
  },
  {
    id: 'disengagement',
    label: '脱离接触',
    family: 'withdraw',
    pattern: 'disengage',
    requirements: ['movement'],
    features: { safety: 1, mobility: 1 },
    base: 2,
  },
  {
    id: 'breakout',
    label: '突围',
    family: 'withdraw',
    pattern: 'breakout',
    requirements: ['movement'],
    features: { concentration: 1, risk: 0.8, initiative: 1 },
  },
  {
    id: 'reconnaissance',
    label: '侦察',
    family: 'security',
    pattern: 'recon',
    requirements: ['recon'],
    features: { recon: 1, safety: 0.5 },
    base: 2,
  },
  {
    id: 'probe',
    label: '试探',
    family: 'security',
    pattern: 'probe',
    features: { recon: 0.8, feint: 0.5 },
  },
  {
    id: 'recon-in-force',
    label: '强行侦察',
    family: 'security',
    pattern: 'recon-force',
    features: { recon: 1, initiative: 0.8, risk: 0.5 },
  },
  {
    id: 'screen',
    label: '警戒',
    family: 'security',
    pattern: 'screen',
    features: { recon: 0.7, hold: 0.5 },
  },
  {
    id: 'cover',
    label: '掩护',
    family: 'security',
    pattern: 'cover',
    features: { fire: 0.8, safety: 0.6 },
  },
  {
    id: 'counterattack',
    label: '反击',
    family: 'exploit',
    pattern: 'counterattack',
    features: { initiative: 1, concentration: 0.8 },
  },
  {
    id: 'counteroffensive',
    label: '反攻',
    family: 'exploit',
    pattern: 'counteroffensive',
    features: { initiative: 1, concentration: 1, patience: 0.5 },
  },
  {
    id: 'exploitation',
    label: '突破扩张',
    family: 'exploit',
    pattern: 'exploit',
    requirements: ['movement'],
    features: { mobility: 1.2, initiative: 1 },
  },
  {
    id: 'pursuit',
    label: '追击',
    family: 'exploit',
    pattern: 'pursuit',
    requirements: ['movement'],
    features: { mobility: 1.5, initiative: 1, risk: 0.5 },
  },
];
function build(d: Definition, c: EvaluationContext): TaskSpec[] {
  const units = own(c),
    ids = units.map((u) => u.id),
    target = targetFor(c),
    start = rallyPoint(c);
  const requested = c.commander.tactics?.parameters?.direction;
  const leftPoint = flankPoint(c, 'left'),
    rightPoint = flankPoint(c, 'right');
  const routeCost = (point: string | undefined) =>
    point && start && target
      ? tacticalDistance(c, start, point) + tacticalDistance(c, point, target)
      : Infinity;
  const direction =
    requested === 'left' || requested === 'right'
      ? requested
      : routeCost(rightPoint) < routeCost(leftPoint)
        ? 'right'
        : 'left';
  const flank = flankPoint(c, direction),
    objective = c.target ?? resolveTarget(c),
    combat = {
      ...makeSpec('assault', 'combat', ids, [], target),
      ...(objective?.kind === 'contact' ? { targetUnitId: objective.unitId } : {}),
    };
  const hold = { ...makeSpec('hold', 'hold', ids, [], target), data: { radius: 1 } };
  const withdraw = {
    ...makeSpec('withdraw', 'withdraw', ids, [], c.goal.kind === 'withdraw' ? target : start),
    data: { radius: ids.length > 1 ? 1 : 0 },
  };
  const contact = makeSpec('contact', 'delay', ids, [], target);
  const rally = {
    ...makeSpec('rally', 'rally', ids, [], start),
    data: { radius: 1 },
    optional: true,
  };
  switch (d.pattern) {
    case 'search':
      return [makeSpec('search', 'search', ids, [], target)];
    case 'frontal':
      return [combat];
    case 'breakthrough':
      return sequence([...(c.profile.coordination ? [rally] : []), combat]);
    case 'sector': {
      const preferred = c.commander.tactics?.parameters?.sector;
      const enemies = visibleEnemies(c.observation, c.commander.side);
      const sector =
        c.observation.map.locations
          .filter(
            (l) =>
              !l.blocked &&
              l.id !== start &&
              (!target || tacticalDistance(c, l.id, target) <= 3) &&
              units.every((u) => Number.isFinite(tacticalDistance(c, u.location, l.id))),
          )
          .sort((a, b) => {
            const score = (l: typeof a) =>
              (l.id === preferred ? -100 : 0) -
              l.cover * 2 +
              enemies
                .filter((e) => tacticalDistance(c, e.location, l.id) <= e.range)
                .reduce((n, e) => n + e.attack, 0) +
              (start ? tacticalDistance(c, start, l.id) * 0.2 : 0);
            return score(a) - score(b) || a.id.localeCompare(b.id);
          })[0]?.id ?? target;
      return sequence([rally, movement('selected-sector', ids, sector), combat]);
    }
    case 'flank':
      return sequence([movement('flank', ids, flank), combat]);
    case 'turn':
      return sequence([
        movement('wide-route', ids, flank, 0),
        movement('rear-approach', ids, target),
        combat,
      ]);
    case 'single':
    case 'double': {
      const support = [units.find((u) => u.range > 1)?.id ?? ids[0]!],
        wings = ids.filter((id) => !support.includes(id));
      const left = wings.filter((_, i) => d.pattern === 'single' || i % 2 === 0);
      const right = d.pattern === 'double' ? wings.filter((_, i) => i % 2 === 1) : [];
      const a = movement(
          'left-wing',
          left,
          flankPoint(c, d.pattern === 'single' ? direction : 'left'),
        ),
        b = movement('right-wing', right, flankPoint(c, 'right'));
      return [
        makeSpec('fix', 'fix', support, [], target),
        a,
        ...(right.length ? [b] : []),
        {
          ...combat,
          after: ['fix', 'left-wing', ...(right.length ? ['right-wing'] : [])],
          data: { requiredSupport: support },
        },
      ];
    }
    case 'fire': {
      const support = units.filter((u) => u.range > 1).map((u) => u.id);
      return [
        makeSpec('prepare-fire', 'fire', support, [], target),
        { ...combat, after: ['prepare-fire'], data: { requiredSupport: support } },
      ];
    }
    case 'stealth':
      return sequence([
        makeSpec('conceal', 'conceal', ids),
        { ...movement('infiltrate', ids, target), data: { radius: 1, peaceful: true } },
        combat,
      ]);
    case 'surprise':
      return sequence([makeSpec('conceal', 'conceal', ids), combat]);
    case 'feint':
      return sequence([makeSpec('demonstrate', 'probe', ids, [], target), withdraw, hold]);
    case 'hold':
      return [hold];
    case 'strongpoint': {
      const t = c.observation.map.locations.find((l) => l.id === target);
      const best =
        c.observation.map.locations
          .filter((l) => !l.blocked && (!t || tacticalDistance(c, l.id, t.id) <= 1))
          .sort((a, b) => b.cover - a.cover || a.id.localeCompare(b.id))[0]?.id ?? target;
      return [{ ...hold, ...(best ? { target: best } : {}) }];
    }
    case 'depth':
      return sequence([contact, withdraw, hold]);
    case 'elastic':
      return sequence([contact, withdraw, combat]);
    case 'mobile':
      return sequence([rally, combat, hold]);
    case 'ambush':
      return sequence([
        makeSpec('conceal', 'conceal', ids),
        makeSpec('wait-contact', 'contact', ids, [], target),
        combat,
      ]);
    case 'delay':
      return sequence([contact, withdraw, { ...hold, data: { radius: 1, once: true } }]);
    case 'fighting-delay':
      return sequence([contact, { ...hold, data: { radius: 1, once: true } }]);
    case 'fighting-withdrawal':
      return sequence([contact, withdraw]);
    case 'bounding': {
      const first = ids.filter((_, i) => i % 2 === 0),
        second = ids.filter((_, i) => i % 2 === 1);
      return [
        makeSpec('cover-first', 'cover', first),
        { ...withdraw, id: 'move-second', unitIds: second },
        makeSpec('cover-second', 'cover', second, ['move-second']),
        { ...withdraw, id: 'move-first', unitIds: first, after: ['cover-first', 'cover-second'] },
      ];
    }
    case 'disengage':
      return [withdraw];
    case 'breakout':
      return sequence([makeSpec('open-corridor', 'probe', ids, [], target), withdraw]);
    case 'recon':
      return sequence([
        { ...movement('recon-approach', ids, target), optional: true },
        makeSpec('observe', 'recon', ids, [], target),
      ]);
    case 'probe':
      return sequence([makeSpec('probe', 'probe', ids, [], target), withdraw]);
    case 'recon-force':
      return sequence([
        makeSpec('force-contact', 'probe', ids, [], target),
        { ...makeSpec('observe', 'recon', ids, [], target), optional: true },
        withdraw,
      ]);
    case 'screen':
      return [hold];
    case 'cover':
      return [makeSpec('cover', 'cover', ids)];
    case 'counterattack':
      return [combat];
    case 'counteroffensive':
      return sequence([rally, combat, hold]);
    case 'exploit':
      return sequence([movement('through-gap', ids, target), combat]);
    case 'pursuit':
      return [combat];
  }
}
export function defaultTactics(): DoctrineRegistry {
  const registry = new DoctrineRegistry();
  for (const d of DEFINITIONS) {
    const features = d.features ?? {};
    const method: TaskMethod = {
      id: d.id,
      label: d.label,
      family: d.family,
      categoryId: d.category ?? d.family,
      version: '2.0.0',
      features,
      requirements: d.requirements ?? [],
      parameters: d.pattern === 'flank' || d.pattern === 'turn' ? { direction: 'auto' } : {},
      applicable(c) {
        const target = c.target ?? resolveTarget(c);
        if (d.pattern === 'search') return target?.kind === 'search';
        if (target?.kind === 'search' && !c.commander.tactics?.doctrineId) return false;
        if (c.goal.kind === 'withdraw' && d.family !== 'withdraw' && d.id !== 'hold-position')
          return false;
        if (!supports(capabilitiesFor(c), d.requirements)) return false;
        if (own(c).length < (d.minUnits ?? 1)) return d.id === 'hold-position';
        if (['flank', 'turn', 'single'].includes(d.pattern)) {
          const direction = c.commander.tactics?.parameters?.direction;
          if (direction === 'left' || direction === 'right') {
            if (!flankPoint(c, direction)) return false;
          } else if (!flankPoint(c, 'left') && !flankPoint(c, 'right')) return false;
        }
        if (d.pattern === 'double' && (!flankPoint(c, 'left') || !flankPoint(c, 'right')))
          return false;
        if (d.pattern === 'fire')
          return own(c).some(
            (u) => u.range > 1 && (!capabilitiesFor(c).mechanisms.ammo || u.ammo > 0),
          );
        if (d.pattern === 'pursuit')
          return visibleEnemies(c.observation, c.commander.side).some((u) =>
            u.tags.some((t) => ['routing', 'retreating'].includes(t)),
          );
        if (d.family === 'exploit')
          return (
            c.assessment.advantage > 0.15 ||
            c.observation.events.some((e) =>
              ['enemy-withdrawal', 'breakthrough', 'counterattack'].includes(e.kind),
            )
          );
        return true;
      },
      score(c) {
        let value = d.base ?? 1;
        if (d.family === 'attack') value += c.assessment.advantage;
        if (d.family === 'defend') value += c.goal.kind === 'defend' ? 4 : -1;
        if (d.family === 'withdraw')
          value += c.goal.kind === 'withdraw' ? 5 : -2 - Math.max(0, c.assessment.advantage);
        if (d.family === 'security') value += c.goal.kind === 'recon' ? 5 : -2;
        if (d.family === 'exploit') value += Math.max(0, c.assessment.advantage) * 2;
        return value;
      },
      phases(c) {
        return build(d, c).map((s) => ({
          id: s.id,
          title: s.id,
          intent: s.task,
          enter: { kind: 'always' },
          complete: { kind: 'at-target' },
          abort: { kind: 'low-strength', value: 0.2 },
          roles: ['assault', 'support', 'reserve'],
        }));
      },
      decompose: (c) => build(d, c),
      actionBias(a) {
        return Object.entries(features).reduce(
          (sum, [key, value]) => sum + (a.features[key] ?? 0) * value,
          0,
        );
      },
    };
    registry.register(method);
  }
  return registry;
}
function prepend(tasks: TaskSpec[], step: TaskSpec): TaskSpec[] {
  return [step, ...tasks.map((t) => ({ ...t, after: t.after.length ? t.after : [step.id] }))];
}
export function defaultModifiers(): Registry<TacticalModifier> {
  const r = new Registry<TacticalModifier>();
  for (const [id, label, operator, requirement] of [
    ['fire-preparation', '火力准备', 'fire', 'ranged-fire'],
    ['suppression', '火力压制', 'suppress', 'suppression'],
    ['smoke-concealment', '烟幕与遮蔽', 'smoke', 'smoke'],
    ['feint', '佯攻', 'probe', ''],
    ['fixing-attack', '牵制', 'fix', ''],
  ])
    r.register({
      id: id!,
      label: label!,
      requirements: requirement ? [requirement] : [],
      compatible: (c) =>
        operator !== 'fire' ||
        own(c).some((u) => u.range > 1 && (!capabilitiesFor(c).mechanisms.ammo || u.ammo > 0)),
      apply: (tasks, c) =>
        prepend(
          tasks,
          makeSpec(
            'modifier-' + id,
            operator!,
            own(c)
              .filter((u, i) =>
                operator === 'fire'
                  ? u.range > 1
                  : ['probe', 'fix'].includes(operator!)
                    ? i === 0
                    : true,
              )
              .map((u) => u.id),
            [],
            targetFor(c),
          ),
        ),
    });
  for (const [id, label] of [
    ['concentration', '集中兵力'],
    ['coordinated-assault', '协同突击'],
  ])
    r.register({
      id: id!,
      label: label!,
      requirements: ['movement'],
      apply: (tasks, c) =>
        prepend(tasks, {
          ...makeSpec(
            'modifier-' + id,
            'rally',
            own(c).map((u) => u.id),
            [],
            rallyPoint(c),
          ),
          data: { radius: 1 },
        }),
    });
  r.register({
    id: 'dispersion',
    label: '分散展开',
    requirements: ['movement', 'flanking'],
    compatible: (c) => own(c).length >= 2 && !!flankPoint(c, 'left') && !!flankPoint(c, 'right'),
    apply: (tasks, c) => {
      const ids = own(c).map((u) => u.id);
      const moves = [
        movement(
          'spread-left',
          ids.filter((_, i) => i % 2 === 0),
          flankPoint(c, 'left'),
        ),
        movement(
          'spread-right',
          ids.filter((_, i) => i % 2 === 1),
          flankPoint(c, 'right'),
        ),
      ];
      return [
        ...moves,
        ...tasks.map((t) => ({ ...t, after: t.after.length ? t.after : moves.map((s) => s.id) })),
      ];
    },
  });
  r.register({
    id: 'reserve-commitment',
    label: '预备队投入',
    requirements: ['movement'],
    compatible: (c) => own(c).length >= 2,
    apply: (tasks, c) => {
      const reserve = own(c).at(-1)!.id;
      const main = tasks.map((t) => ({
        ...t,
        unitIds: t.unitIds.filter((id) => id !== reserve),
        optional: t.optional || t.unitIds.every((id) => id === reserve),
      }));
      return [
        ...main,
        {
          ...makeSpec('commit-reserve', 'commit', [reserve], [], targetFor(c)),
          data: { threshold: -0.15, delay: 2 },
        },
      ];
    },
  });
  r.register({
    id: 'economy-of-force',
    label: '次要方向节约兵力',
    compatible: (c) => own(c).length >= 2,
    apply: (tasks, c) => {
      const ids = own(c).map((u) => u.id),
        active = new Set(ids.slice(0, Math.ceil(ids.length / 2)));
      return [
        ...tasks.map((t) => ({
          ...t,
          unitIds: t.unitIds.filter((id) => active.has(id)),
          optional: t.optional || t.unitIds.every((id) => !active.has(id)),
        })),
        {
          ...makeSpec(
            'economy-guard',
            'hold',
            ids.filter((id) => !active.has(id)),
            [],
            rallyPoint(c),
          ),
          data: { radius: 1 },
        },
      ];
    },
  });
  return r;
}
