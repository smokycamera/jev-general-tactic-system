import type { Observation } from './types.js';
import type { CapabilityResolver, ResolvedCapabilities } from './execution-types.js';

export const defaultCapabilityResolver: CapabilityResolver = {
  resolve(o) {
    return {
      mechanisms: {
        movement: o.map.locations.some((l) => l.neighbors.length > 0),
        'ranged-fire': o.units.some((u) => u.range > 1),
        ...o.capabilities?.mechanisms,
      },
      actionKinds: {
        move: ['move'],
        attack: ['attack'],
        wait: ['wait'],
        defend: ['defend'],
        recon: ['recon'],
        suppress: ['suppress'],
        smoke: ['smoke'],
        conceal: ['conceal'],
        ...o.capabilities?.actionKinds,
      },
      fullyObservable: o.capabilities?.fullyObservable === true,
    };
  },
};
export function supports(
  capabilities: ResolvedCapabilities,
  requirements: readonly string[] = [],
): boolean {
  return requirements.every((id) => capabilities.mechanisms[id] === true);
}
export function isAction(
  capabilities: ResolvedCapabilities,
  semantic: string,
  kind: string,
): boolean {
  return (capabilities.actionKinds[semantic] ?? [semantic]).includes(kind);
}
export function visibleEnemies(o: Observation, side: string) {
  return o.units.filter(
    (u) => u.side !== side && u.side !== 'neutral' && u.hp > 0 && !u.tags.includes('evacuated'),
  );
}
