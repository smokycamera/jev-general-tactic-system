import { StyleDimensionRegistry } from './registry.js';
const definitions = [
  ['flank', '侧翼倾向', '正面直达', '迂回包抄', 'flank'],
  ['firepower', '火力倾向', '接近突击', '集中射击', 'fire'],
  ['reserve', '预备队投入倾向', '保留后手', '尽早投入', 'commit'],
  ['focus', '任务专注', '灵活调整', '追求任务', 'objective'],
  ['concentration', '集中倾向', '分散覆盖', '集中关键点', 'concentration'],
  ['hold', '坚守倾向', '让出空间', '保持阵地', 'hold'],
  ['feint', '佯攻倾向', '直接行动', '牵制示形', 'feint'],
  ['initiative', '进取倾向', '等待试探', '主动推进', 'initiative'],
  ['risk', '风险容忍', '稳定结果', '冒险收益', 'risk'],
  ['preservation', '兵力保全', '愿担损失', '保留兵力', 'safety'],
  ['mobility', '机动倾向', '稳定部署', '转移换位', 'mobility'],
  ['recon', '侦察倾向', '现有信息', '侦察验证', 'recon'],
  ['patience', '耐心倾向', '尽快见效', '等待协同', 'patience'],
  ['autonomy', '自主倾向', '遵循方法', '调整方法', 'autonomy'],
] as const;
export function defaultStyles(): StyleDimensionRegistry {
  const registry = new StyleDimensionRegistry();
  for (const [id, label, low, high, feature] of definitions)
    registry.register({
      id,
      label,
      low,
      high,
      effect: `影响候选的 ${feature} 项评分；50 时贡献为零`,
      contribution: (features, value) => ((value - 50) / 50) * (features[feature] ?? 0) * 2.5,
    });
  return registry;
}
export const DEFAULT_STYLE = Object.fromEntries(definitions.map((d) => [d[0], 50]));
