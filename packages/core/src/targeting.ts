import type { EvaluationContext, Observation, TacticalMemory, TacticalTarget } from './types.js';
import { visibleEnemies } from './capabilities.js';
import { createDistanceLookup } from './util.js';

export function rememberLocations(
  memory: TacticalMemory,
  observation: Observation,
  side: string,
): void {
  const valid = new Set(observation.map.locations.filter((l) => !l.blocked).map((l) => l.id));
  const current = observation.units
    .filter((u) => u.side === side && u.hp > 0 && !u.tags.includes('evacuated'))
    .map((u) => u.location);
  memory.visited = [
    ...new Set([
      ...memory.visited.filter((id) => valid.has(id) && !current.includes(id)),
      ...current,
    ]),
  ].slice(-512);
}

/** Uses observed units and known map geometry only. A search location is not an enemy claim. */
export function resolveTarget(
  c: EvaluationContext,
  previous?: TacticalTarget,
): TacticalTarget | undefined {
  if (c.goal.target) return { kind: 'fixed', location: c.goal.target };
  const own = c.observation.units.filter(
    (u) => c.commander.unitIds.includes(u.id) && u.hp > 0 && !u.tags.includes('evacuated'),
  );
  if (!own.length) return undefined;
  const distance = createDistanceLookup(c.observation.map);
  const enemies = visibleEnemies(c.observation, c.commander.side);
  const tracked = enemies.find((u) => previous?.kind === 'contact' && u.id === previous.unitId);
  const target =
    tracked ??
    [...enemies].sort((a, b) => {
      // Group distance prevents the first listed flank from becoming the universal objective.
      const cost = (location: string) =>
        own.reduce((n, u) => n + distance(u.location, location), 0);
      return cost(a.location) - cost(b.location) || a.id.localeCompare(b.id);
    })[0];
  if (target) return { kind: 'contact', location: target.location, unitId: target.id };
  if (
    (c.capabilities?.fullyObservable ?? c.observation.capabilities?.fullyObservable) ||
    !['eliminate', 'recon'].includes(c.goal.kind) ||
    c.capabilities?.mechanisms.movement === false
  )
    return { kind: 'fixed', location: own[0]!.location };

  const visited = c.memory?.visited ?? own.map((u) => u.location);
  const known = new Map(visited.map((id, i) => [id, i]));
  const reachable = c.observation.map.locations.filter(
    (l) => !l.blocked && own.every((u) => Number.isFinite(distance(u.location, l.id))),
  );
  // Retain a waypoint while en route; after losing sight, check the last observed location once.
  if (
    previous &&
    previous.kind !== 'fixed' &&
    reachable.some((l) => l.id === previous.location) &&
    !own.some((u) => u.location === previous.location) &&
    (previous.kind === 'search' || !known.has(previous.location))
  )
    return { kind: 'search', location: previous.location };
  const center = reachable.reduce(
    (p, l) => ({ x: p.x + l.x / reachable.length, y: p.y + l.y / reachable.length }),
    { x: 0, y: 0 },
  );
  const next = reachable
    .filter((l) => !own.some((u) => u.location === l.id))
    .sort((a, b) => {
      const age = (id: string) => known.get(id) ?? -1;
      const cost = (l: typeof a) =>
        Math.hypot(l.x - center.x, l.y - center.y) +
        (own.reduce((n, u) => n + distance(u.location, l.id), 0) / own.length) * 0.2;
      return age(a.id) - age(b.id) || cost(a) - cost(b) || a.id.localeCompare(b.id);
    })[0];
  return next ? { kind: 'search', location: next.id } : undefined;
}

/** Contact movement updates bindings locally; only a change of intent needs another plan. */
export function targetIntent(target?: TacticalTarget): string {
  return target
    ? `${target.kind}:${target.kind === 'contact' ? target.unitId : target.location}`
    : '';
}
