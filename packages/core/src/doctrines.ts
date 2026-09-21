import { DoctrineRegistry } from './registry.js';
import type { BattleAction, EvaluationContext, Features, Phase } from './types.js';
const phases = (labels: string[], roles: string[]): Phase[] =>
  labels.map((title, i) => ({
    id: `p${i}`,
    title,
    intent: title,
    enter: { kind: i === 0 ? 'always' : 'turns', value: 1 },
    complete: { kind: 'turns', value: i === 0 ? 1 : 2 },
    abort: { kind: 'low-strength', value: 0.2 },
    roles,
  }));
type Spec = {
  id: string;
  label: string;
  family: string;
  features: Features;
  labels: string[];
  roles: string[];
  score: (c: EvaluationContext) => number;
  bias: (a: BattleAction, c: EvaluationContext) => number;
};
const f = (a: BattleAction, key: string) => a.features[key] ?? 0;
export function defaultDoctrines(): DoctrineRegistry {
  const registry = new DoctrineRegistry();
  const specs: Spec[] = [
    {
      id: 'central-breakthrough',
      label: '中央突破',
      family: 'attack',
      features: { concentration: 1, initiative: 1, risk: 0.5, mobility: 0.4, flank: -1 },
      labels: ['接近突破口', '集中兵力', '突破正面', '扩大战果', '巩固通路', '转向后续目标'],
      roles: ['assault', 'support', 'reserve'],
      score: (c) => 2 + c.assessment.advantage,
      bias: (a) => f(a, 'objective') * 2 + f(a, 'concentration') - f(a, 'flank'),
    },
    {
      id: 'flank-breakthrough',
      label: '侧翼突破',
      family: 'attack',
      features: { flank: 1, mobility: 1, initiative: 0.5, autonomy: 0.6 },
      labels: ['选择侧翼通路', '掩护展开', '侧翼突击', '切入纵深', '协同合围', '巩固战果'],
      roles: ['flank', 'support', 'reserve'],
      score: (c) => 2 + (c.assessment.blocked.length ? 0.8 : 0),
      bias: (a) => f(a, 'flank') * 3 + f(a, 'mobility') + 0.5 * f(a, 'objective'),
    },
    {
      id: 'envelopment',
      label: '包抄',
      family: 'attack',
      features: { flank: 1, concentration: -0.5, patience: 0.8, mobility: 1 },
      labels: ['两翼展开', '牵制正面', '进入侧后', '同步合围', '压缩阵地', '收拢部队'],
      roles: ['flank', 'fix', 'flank', 'reserve'],
      score: (c) => 1 + (c.profile.coordination >= 2 ? 1.2 : -0.6),
      bias: (a) => f(a, 'flank') * 2 + f(a, 'concentration') * 0.4 + f(a, 'objective'),
    },
    {
      id: 'fire-then-assault',
      label: '火力准备后突击',
      family: 'attack',
      features: { fire: 1, patience: 1, concentration: 1, safety: 0.4 },
      labels: ['建立火力阵位', '集中压制', '突击部队接近', '协同突击', '转移火力', '控制目标'],
      roles: ['support', 'assault', 'reserve'],
      score: (c) =>
        1 +
        c.observation.units.filter((u) => c.commander.unitIds.includes(u.id) && u.range > 1)
          .length *
          0.6,
      bias: (a, c) =>
        f(a, 'fire') * 2 +
        (c.observation.turn > 2 ? f(a, 'initiative') * 2 : 0) +
        f(a, 'objective'),
    },
    {
      id: 'hold-position',
      label: '固守',
      family: 'defend',
      features: { hold: 1, fire: 0.7, mobility: -1, safety: 0.3 },
      labels: ['占据阵地', '组织火力', '击退进攻', '修复薄弱点', '接替守军', '巩固阵地'],
      roles: ['hold', 'support', 'reserve'],
      score: (c) => 2 + (c.goal.kind === 'defend' ? 3 : 0),
      bias: (a) => f(a, 'hold') * 2 + f(a, 'fire') + f(a, 'objective') * 2,
    },
    {
      id: 'elastic-defense',
      label: '弹性防御',
      family: 'defend',
      features: { hold: -0.7, mobility: 1, patience: 0.7, safety: 0.8 },
      labels: ['建立纵深', '接触迟滞', '让出受压地段', '诱敌延伸', '侧击反扑', '恢复阵线'],
      roles: ['screen', 'reserve', 'support'],
      score: (c) => 2 + (c.assessment.advantage < 0 ? 1 : 0),
      bias: (a) => f(a, 'safety') * 2 + f(a, 'mobility') + f(a, 'fire'),
    },
    {
      id: 'mobile-defense',
      label: '机动防御',
      family: 'defend',
      features: { mobility: 1, hold: -0.4, commit: 0.5, autonomy: 1 },
      labels: ['探明主攻方向', '调整部署', '局部集中', '机动反击', '撤出接触', '重新部署'],
      roles: ['screen', 'flank', 'reserve'],
      score: (c) => 1.5 + (c.profile.coordination >= 2 ? 0.8 : 0),
      bias: (a) => f(a, 'mobility') * 2 + f(a, 'safety') + f(a, 'flank'),
    },
    {
      id: 'delay-lines',
      label: '逐线迟滞',
      family: 'defend',
      features: { hold: -0.6, patience: 1, mobility: 0.7, safety: 1 },
      labels: ['占据首道防线', '短暂阻滞', '退到后方阵地', '交替接替', '再次迟滞', '脱离接触'],
      roles: ['screen', 'support', 'reserve'],
      score: (c) => 1 + (c.assessment.advantage < -0.2 ? 2 : 0),
      bias: (a) => f(a, 'fire') + f(a, 'safety') * 2 + f(a, 'patience'),
    },
    {
      id: 'feint-fix',
      label: '佯攻牵制',
      family: 'attack',
      features: { feint: 1, risk: 0.2, autonomy: 1, concentration: -0.6 },
      labels: ['选择牵制点', '有限接触', '显示进攻意图', '牵住对手', '配合主攻', '脱离或转进'],
      roles: ['fix', 'flank', 'support'],
      score: (c) => 1 + (c.commander.parentId ? 0.5 : 0),
      bias: (a) => f(a, 'feint') * 3 + f(a, 'mobility') + f(a, 'safety'),
    },
    {
      id: 'bounding-withdrawal',
      label: '交替掩护撤退',
      family: 'withdraw',
      features: { safety: 1, mobility: 1, hold: -1, patience: 0.5 },
      labels: ['确定撤离通路', '留组掩护', '首组转移', '交换掩护', '后组撤出', '集结清点'],
      roles: ['withdraw', 'cover', 'reserve'],
      score: (c) => (c.goal.kind === 'withdraw' ? 6 : Math.max(0, -c.assessment.advantage * 3)),
      bias: (a) => f(a, 'retreat') * 4 + f(a, 'safety') + f(a, 'fire') * 0.5,
    },
  ];
  for (const spec of specs)
    registry.register({
      id: spec.id,
      label: spec.label,
      family: spec.family,
      features: spec.features,
      version: '1.0.0',
      applicable: (context) => {
        const units = context.observation.units.filter(
          (unit) => context.commander.unitIds.includes(unit.id) && unit.hp > 0,
        );
        if (spec.id === 'fire-then-assault')
          return units.some((unit) => unit.range > 1 && unit.ammo > 0);
        if (spec.id === 'envelopment') return units.length >= 2;
        return true;
      },
      score: spec.score,
      phases: (c) => phases(spec.labels, spec.roles).slice(0, c.profile.horizon),
      actionBias: spec.bias,
    });
  return registry;
}
