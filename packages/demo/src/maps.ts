import type { BattleMap, Location } from '@jev/core';
export function gridMap(width = 10, height = 7): BattleMap {
  const locations: Location[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      locations.push({
        id: `${x},${y}`,
        label: `${x},${y}`,
        x,
        y,
        cover: x === 4 || x === 5 ? 0.4 : 0,
        blocked: x === 4 && y >= 2 && y <= 4,
        neighbors: [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]
          .filter(([a, b]) => a! >= 0 && a! < width && b! >= 0 && b! < height)
          .map(([a, b]) => `${a},${b}`),
      });
  return { kind: 'grid', locations };
}
export function regionMap(): BattleMap {
  const definitions: [string, string, number, number, number, string[]][] = [
    ['blue-base', '西侧营地', 0, 2, 0.3, ['west-high', 'west-road', 'west-woods']],
    ['west-high', '西侧高地', 2, 0, 0.5, ['blue-base', 'north-pass']],
    ['west-road', '西侧大道', 2, 2, 0, ['blue-base', 'bridge', 'west-woods']],
    ['west-woods', '西侧林地', 2, 4, 0.6, ['blue-base', 'south-pass', 'west-road']],
    ['north-pass', '北侧隘口', 4, 0, 0.3, ['west-high', 'east-high']],
    ['bridge', '中央桥梁', 4, 2, 0, ['west-road', 'east-road']],
    ['south-pass', '南侧便道', 4, 4, 0.3, ['west-woods', 'east-woods']],
    ['east-high', '东侧高地', 6, 0, 0.5, ['north-pass', 'red-base']],
    ['east-road', '东侧大道', 6, 2, 0, ['bridge', 'red-base', 'east-woods']],
    ['east-woods', '东侧林地', 6, 4, 0.6, ['south-pass', 'red-base', 'east-road']],
    ['red-base', '东侧营地', 8, 2, 0.3, ['east-high', 'east-road', 'east-woods']],
  ];
  return {
    kind: 'regions',
    locations: definitions.map(([id, label, x, y, cover, neighbors]) => ({
      id,
      label,
      x,
      y,
      cover,
      neighbors,
      blocked: false,
    })),
  };
}
