import { assert, clone, distance, stable } from '@jev/core';
import type {
  ActionEnvelope,
  ActionReceipt,
  BattleAction,
  BattleAdapter,
  BattleMap,
  Commander,
  Features,
  Goal,
  HostEvent,
  Json,
  Observation,
  Unit,
} from '@jev/core';
import { gridMap, regionMap } from './maps.js';
interface DemoState {
  observation: Observation;
  seed: number;
  receipts: Record<string, ActionReceipt>;
  guard: string[];
  scouted: string[];
}
const alive = (u: Unit) => u.hp > 0 && !u.tags.includes('evacuated');
export function defaultCommanders(): Commander[] {
  return [
    {
      id: 'blue',
      name: '蓝方指挥官',
      side: 'blue',
      unitIds: ['b1', 'b2'],
      ability: 'skilled',
      style: {},
    },
    {
      id: 'blue-wing',
      name: '蓝方侧翼队长',
      side: 'blue',
      parentId: 'blue',
      unitIds: ['b3'],
      ability: 'regular',
      style: { flank: 75 },
    },
    {
      id: 'red',
      name: '红方指挥官',
      side: 'red',
      unitIds: ['r1', 'r2', 'r3'],
      ability: 'regular',
      style: { hold: 65, firepower: 65 },
    },
  ];
}
export function createObservation(kind = 'grid', sessionId = `demo-${kind}`): Observation {
  const map = kind === 'regions' ? regionMap() : gridMap();
  const starts =
    kind === 'regions'
      ? ['west-high', 'west-road', 'west-woods', 'east-high', 'east-road', 'east-woods']
      : ['1,1', '1,3', '1,5', '8,1', '8,3', '8,5'];
  const units = starts.map((location, i): Unit => ({
    id: `${i < 3 ? 'b' : 'r'}${(i % 3) + 1}`,
    name: `${i < 3 ? '蓝' : '红'}${['突击队', '火力队', '机动队'][i % 3]}`,
    side: i < 3 ? 'blue' : 'red',
    location,
    hp: 24,
    maxHp: 24,
    attack: i % 3 === 1 ? 7 : 6,
    range: i % 3 === 1 ? 3 : 1,
    ap: 2,
    ammo: 12,
    tags: i % 3 === 1 ? ['ranged'] : ['melee'],
  }));
  const goals: Goal[] = [
    {
      id: 'mission',
      title: '控制东侧据点',
      kind: 'capture',
      side: 'blue',
      target: kind === 'regions' ? 'red-base' : '8,3',
      priority: 70,
      source: 'host',
      version: 1,
    },
    {
      id: 'mission',
      title: '控制西侧据点',
      kind: 'capture',
      side: 'red',
      target: kind === 'regions' ? 'blue-base' : '1,3',
      priority: 70,
      source: 'host',
      version: 1,
    },
  ];
  return {
    sessionId,
    capabilities: {
      mechanisms: {
        movement: true,
        'ranged-fire': true,
        ammo: true,
        terrain: true,
        flanking: true,
        recon: true,
      },
      fullyObservable: true,
    },
    version: 0,
    turn: 1,
    activeSide: 'blue',
    units,
    map,
    goals,
    events: [{ id: 'start-0', kind: 'start' }],
    ended: false,
  };
}
export class DemoAdapter implements BattleAdapter {
  readonly id = 'demo';
  private state: DemoState;
  constructor(observation: Observation = createObservation(), seed = 20260921) {
    this.state = {
      observation: clone(observation),
      seed: seed >>> 0,
      receipts: {},
      guard: [],
      scouted: [],
    };
  }
  async observe(): Promise<Observation> {
    return clone(this.state.observation);
  }
  async receipt(key: string): Promise<ActionReceipt | null> {
    return clone(this.state.receipts[key] ?? null);
  }
  async snapshot(): Promise<Json> {
    return JSON.parse(JSON.stringify(this.state)) as Json;
  }
  async restore(snapshot: Json): Promise<void> {
    assert(
      snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
      'invalid demo snapshot',
    );
    const data = snapshot as unknown as DemoState;
    assert(
      data.observation?.sessionId &&
        Number.isInteger(data.seed) &&
        data.receipts &&
        Array.isArray(data.guard) &&
        Array.isArray(data.scouted),
      'invalid demo snapshot',
    );
    this.state = clone(data);
  }
  private random(): number {
    let x = this.state.seed || 1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state.seed = x >>> 0;
    return this.state.seed / 4294967296;
  }
  private los(o: Observation, from: Unit, to: Unit): boolean {
    if (o.map.kind !== 'grid') return true;
    const a = o.map.locations.find((l) => l.id === from.location)!,
      b = o.map.locations.find((l) => l.id === to.location)!;
    let x = a.x,
      y = a.y;
    const dx = Math.abs(b.x - x),
      dy = -Math.abs(b.y - y),
      sx = x < b.x ? 1 : -1,
      sy = y < b.y ? 1 : -1;
    let err = dx + dy;
    while (x !== b.x || y !== b.y) {
      const e = 2 * err;
      if (e >= dy) {
        err += dy;
        x += sx;
      }
      if (e <= dx) {
        err += dx;
        y += sy;
      }
      if (x === b.x && y === b.y) break;
      const id = `${x},${y}`;
      if (
        o.map.locations.find((l) => l.id === id)?.blocked ||
        o.units.some((u) => alive(u) && u.side !== from.side && u.location === id)
      )
        return false;
    }
    return true;
  }
  async legalActions(o: Observation, unitIds: readonly string[]): Promise<BattleAction[]> {
    if (o.ended) return [];
    const actions: BattleAction[] = [];
    for (const unit of o.units.filter(
      (u) => unitIds.includes(u.id) && u.side === o.activeSide && alive(u) && u.ap > 0,
    )) {
      const enemies = o.units.filter(
        (u) => u.side !== unit.side && u.side !== 'neutral' && alive(u),
      );
      const goal = o.goals
        .filter((g) => g.side === unit.side)
        .sort((a, b) => b.priority - a.priority)[0];
      const nearest = [...enemies].sort(
        (a, b) =>
          distance(o.map, unit.location, a.location) - distance(o.map, unit.location, b.location),
      )[0];
      const target = goal?.target ?? nearest?.location ?? unit.location;
      const current = o.map.locations.find((l) => l.id === unit.location)!;
      const safeDistance = (from: string, to: string) => Math.min(30, distance(o.map, from, to));
      const features = (location: string): Features => {
        const cell = o.map.locations.find((l) => l.id === location)!;
        const threat =
          enemies.reduce(
            (s, e) => s + (distance(o.map, location, e.location) <= e.range ? e.attack : 0),
            0,
          ) / Math.max(1, unit.hp);
        const objective =
          (safeDistance(unit.location, target) - safeDistance(location, target)) * 0.5;
        return {
          objective: location === target ? 1 : objective,
          risk: threat,
          counterfire: threat,
          encirclement:
            enemies.filter((e) => distance(o.map, location, e.location) <= 2).length * 0.3,
          supplyRisk: unit.ammo === 0 ? 0.7 : 0.1,
          safety: Math.max(-1, 1 - threat * 2),
          cover: cell.cover,
          flank: Math.abs(cell.y - (o.map.kind === 'grid' ? 3 : 2)) * 0.25,
          concentration: enemies.length ? 1 / (1 + safeDistance(location, nearest!.location)) : 0,
          fire: 0,
          initiative: 0,
          mobility: 0,
          hold: 0,
          patience: 0,
          recon: 0,
          feint: 0,
          autonomy: 0,
          retreat: 0,
          commit: 1,
        };
      };
      for (const destination of current.neighbors) {
        const cell = o.map.locations.find((l) => l.id === destination);
        if (!cell || cell.blocked || o.units.some((u) => alive(u) && u.location === destination))
          continue;
        const f = features(destination);
        f.mobility = 1;
        f.initiative = f.objective! > 0 ? 1 : -0.2;
        f.hold = -1;
        f.retreat = (unit.side === 'blue' ? current.x - cell.x : cell.x - current.x) * 0.5;
        f.autonomy = f.flank!;
        f.feint = (f.flank ?? 0) * (unit.hp / unit.maxHp);
        actions.push({
          id: `${unit.id}:move:${destination}`,
          unitId: unit.id,
          kind: 'move',
          destination,
          cost: 1,
          features: f,
        });
      }
      for (const enemy of enemies) {
        if (
          distance(o.map, unit.location, enemy.location) > unit.range ||
          !this.los(o, unit, enemy) ||
          (unit.range > 1 && unit.ammo <= 0)
        )
          continue;
        const f = features(unit.location);
        f.damage = Math.min(enemy.hp, unit.attack) / 6;
        f.fire = unit.range > 1 ? 1 : -0.4;
        f.initiative = 1;
        f.objective = 0.5;
        f.concentration = 1 - enemy.hp / enemy.maxHp;
        f.feint = 0.2;
        actions.push({
          id: `${unit.id}:attack:${enemy.id}`,
          unitId: unit.id,
          kind: 'attack',
          targetId: enemy.id,
          cost: 1,
          features: f,
        });
      }
      const defense = features(unit.location);
      defense.hold = 1;
      defense.patience = 0.6;
      defense.safety = 1;
      defense.commit = -1;
      actions.push({
        id: `${unit.id}:defend`,
        unitId: unit.id,
        kind: 'defend',
        cost: unit.ap,
        features: defense,
      });
      if (!this.state.scouted.includes(`${unit.id}:${o.turn}`)) {
        const scout = features(unit.location);
        scout.recon = 1;
        scout.patience = 0.5;
        scout.safety = 0.5;
        scout.commit = -0.5;
        actions.push({
          id: `${unit.id}:recon`,
          unitId: unit.id,
          kind: 'recon',
          cost: 1,
          features: scout,
        });
      }
      actions.push({
        id: `${unit.id}:wait`,
        unitId: unit.id,
        kind: 'wait',
        cost: unit.ap,
        features: { ...features(unit.location), patience: 1, commit: -1 },
      });
    }
    return actions;
  }
  async execute(envelope: ActionEnvelope): Promise<ActionReceipt> {
    // No await between final validation and mutation. Serial, atomic within this host.
    const existing = this.state.receipts[envelope.key];
    if (existing) return clone(existing);
    const o = this.state.observation;
    assert(
      envelope.sessionId === o.sessionId && envelope.stateVersion === o.version,
      'stale host version',
    );
    const legal = await this.legalActions(clone(o), [envelope.action.unitId]);
    const concurrent = this.state.receipts[envelope.key];
    if (concurrent) return clone(concurrent);
    assert(envelope.stateVersion === o.version, 'stale host version');
    const action = legal.find((a) => stable(a) === stable(envelope.action));
    assert(action, 'illegal action');
    const unit = o.units.find((u) => u.id === action.unitId)!;
    unit.ap -= action.cost;
    let detail = `${unit.name} ${action.kind}`;
    if (action.kind === 'move') unit.location = action.destination!;
    if (action.kind === 'attack') {
      const enemy = o.units.find((u) => u.id === action.targetId)!;
      const cell = o.map.locations.find((l) => l.id === enemy.location)!;
      const guard = this.state.guard.includes(enemy.id) ? 0.55 : 1;
      const damage = Math.max(
        1,
        Math.round(unit.attack * (0.8 + this.random() * 0.4) * (1 - cell.cover * 0.4) * guard),
      );
      enemy.hp = Math.max(0, enemy.hp - damage);
      if (unit.range > 1) unit.ammo--;
      detail = `${unit.name} 对 ${enemy.name} 造成 ${damage} 点伤害`;
      if (enemy.hp === 0)
        o.events.push({ id: `loss-${o.version + 1}`, kind: 'loss', unitIds: [enemy.id] });
    }
    if (action.kind === 'defend' && !this.state.guard.includes(unit.id))
      this.state.guard.push(unit.id);
    if (action.kind === 'recon') this.state.scouted.push(`${unit.id}:${o.turn}`);
    o.version++;
    this.checkEnd();
    if (
      !o.ended &&
      o.units.filter((u) => u.side === o.activeSide && alive(u)).every((u) => u.ap <= 0)
    ) {
      o.activeSide = o.activeSide === 'blue' ? 'red' : 'blue';
      if (o.activeSide === 'blue') o.turn++;
      for (const u of o.units.filter((u) => u.side === o.activeSide)) {
        u.ap = 2;
        this.state.guard = this.state.guard.filter((id) => id !== u.id);
      }
      o.events.push({ id: `turn-${o.version}`, kind: 'turn' });
      if (o.turn > 40) {
        o.ended = true;
        o.winner = 'draw';
      }
    }
    const receipt: ActionReceipt = {
      key: envelope.key,
      actionId: action.id,
      stateVersion: o.version,
      applied: true,
      detail,
    };
    this.state.receipts[envelope.key] = receipt;
    return clone(receipt);
  }
  private checkEnd() {
    const o = this.state.observation;
    for (const side of ['blue', 'red']) {
      const own = o.units.filter((u) => u.side === side && alive(u));
      const enemies = o.units.filter((u) => u.side !== side && u.side !== 'neutral' && alive(u));
      if (enemies.length === 0) {
        o.ended = true;
        o.winner = side;
        return;
      }
      const goals = o.goals.filter((g) => g.side === side);
      for (const g of goals)
        if (g.kind === 'capture' && own.some((u) => u.location === g.target)) {
          o.ended = true;
          o.winner = side;
          return;
        }
    }
  }
  /** Test/demo host event. Real adapters receive these facts from their game engine. */
  inject(event: HostEvent, mutate?: (observation: Observation) => void): void {
    mutate?.(this.state.observation);
    this.state.observation.version++;
    this.state.observation.events.push(clone(event));
  }
  setGoals(goals: Goal[]): void {
    this.inject({ id: `goals-${this.state.observation.version + 1}`, kind: 'goal' }, (o) => {
      o.goals = clone(goals);
    });
  }
}
