import type {
  Ability,
  CapabilityProfile,
  Commander,
  DecisionContext,
  DecisionStage,
  Features,
  StyleDimension,
  TaskMethod,
  WorkflowProfile,
} from './types.js';
import { assert, deadline } from './util.js';
export class Registry<T extends { id: string }> {
  protected items = new Map<string, T>();
  register(item: T): this {
    assert(/^[a-z][a-z0-9_.-]*$/i.test(item.id), 'invalid registry id');
    assert(!this.items.has(item.id), `duplicate module: ${item.id}`);
    this.items.set(item.id, item);
    return this;
  }
  get(id: string): T {
    const item = this.items.get(id);
    assert(item, `unknown module: ${id}`);
    return item;
  }
  all(): T[] {
    return [...this.items.values()];
  }
  has(id: string): boolean {
    return this.items.has(id);
  }
  replace(item: T): this {
    assert(this.items.has(item.id), 'cannot replace unknown module: ' + item.id);
    this.items.set(item.id, item);
    return this;
  }
}
export class DoctrineRegistry extends Registry<TaskMethod> {}
export class StyleDimensionRegistry extends Registry<StyleDimension> {
  score(features: Features, style: Record<string, number>): number {
    return this.all().reduce((s, d) => s + d.contribution(features, style[d.id] ?? 50), 0);
  }
  validate(style: Record<string, number>): void {
    for (const [id, value] of Object.entries(style)) {
      this.get(id);
      assert(
        Number.isInteger(value) && value >= 0 && value <= 100,
        `style ${id}: expected integer 0–100`,
      );
    }
  }
}
export class Workflow {
  private ordered: DecisionStage[];
  constructor(registry: Registry<DecisionStage>, profile: WorkflowProfile) {
    const active = new Set(profile.stages);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const ordered: DecisionStage[] = [];
    const visit = (id: string) => {
      assert(active.has(id), `missing stage dependency: ${id}`);
      assert(!visiting.has(id), `workflow cycle: ${id}`);
      if (visited.has(id)) return;
      const stage = registry.get(id);
      assert(
        stage.capabilities.every((c) => profile.capabilities.includes(c)),
        `missing capability: ${id}`,
      );
      assert(stage.budgetMs > 0 && Number.isFinite(stage.budgetMs), 'invalid stage budget');
      visiting.add(id);
      stage.dependencies.forEach(visit);
      visiting.delete(id);
      visited.add(id);
      ordered.push(stage);
    };
    profile.stages.forEach(visit);
    this.ordered = ordered;
  }
  async run(context: DecisionContext): Promise<void> {
    return this.runDraft(context);
  }
  /** Stages mutate the same draft; bounded stages receive the parent's cancellation signal. */
  async runDraft(context: DecisionContext): Promise<void> {
    for (const stage of this.ordered) {
      if (context.signal.aborted) throw new Error('cancelled');
      if (stage.enabled && !stage.enabled(context)) continue;
      await deadline(
        async (signal) => {
          const draft = { ...context, signal };
          await stage.run(draft);
          if (!signal.aborted) Object.assign(context, draft, { signal: context.signal });
        },
        stage.budgetMs,
        context.signal,
      );
      context.trace.push(stage.id);
    }
  }
}
export const PROFILES: Record<Ability, CapabilityProfile> = {
  novice: {
    id: 'novice',
    label: '新手',
    candidateLimit: 2,
    horizon: 1,
    factors: ['objective', 'threat'],
    coordination: 0,
    branches: 0,
    enemyResponses: 0,
  },
  regular: {
    id: 'regular',
    label: '普通',
    candidateLimit: 3,
    horizon: 2,
    factors: ['objective', 'threat', 'role'],
    coordination: 1,
    branches: 0,
    enemyResponses: 0,
  },
  skilled: {
    id: 'skilled',
    label: '熟练',
    candidateLimit: 4,
    horizon: 3,
    factors: ['objective', 'threat', 'role', 'terrain', 'phase'],
    coordination: 2,
    branches: 1,
    enemyResponses: 0,
  },
  expert: {
    id: 'expert',
    label: '优秀',
    candidateLimit: 6,
    horizon: 4,
    factors: ['objective', 'threat', 'role', 'terrain', 'phase', 'response', 'reserve'],
    coordination: 3,
    branches: 2,
    enemyResponses: 1,
  },
  master: {
    id: 'master',
    label: '大师',
    candidateLimit: 8,
    horizon: 6,
    factors: [
      'objective',
      'threat',
      'role',
      'terrain',
      'phase',
      'response',
      'reserve',
      'cross-group',
    ],
    coordination: 4,
    branches: 3,
    enemyResponses: 3,
  },
};
export function validateCommanders(
  commanders: Commander[],
  styles: StyleDimensionRegistry,
  profiles: Record<string, CapabilityProfile>,
): void {
  const ids = new Set<string>();
  const units = new Set<string>();
  for (const c of commanders) {
    assert(!ids.has(c.id), 'duplicate commander');
    ids.add(c.id);
    assert(profiles[c.ability], 'unknown ability');
    styles.validate(c.style);
    if (c.tactics !== undefined) {
      assert(
        c.tactics && typeof c.tactics === 'object' && !Array.isArray(c.tactics),
        'invalid tactical preferences',
      );
      assert(
        c.tactics.doctrineId === undefined || typeof c.tactics.doctrineId === 'string',
        'invalid doctrine preference',
      );
      assert(
        c.tactics.modifiers === undefined ||
          (Array.isArray(c.tactics.modifiers) &&
            c.tactics.modifiers.every((s) => typeof s === 'string')),
        'invalid modifier preference',
      );
      assert(
        c.tactics.parameters === undefined ||
          (c.tactics.parameters &&
            typeof c.tactics.parameters === 'object' &&
            !Array.isArray(c.tactics.parameters)),
        'invalid tactical parameters',
      );
    }
    for (const u of c.unitIds) {
      assert(!units.has(u), `multiple commanders own ${u}`);
      units.add(u);
    }
  }
  for (const c of commanders) {
    let current: Commander | undefined = c;
    const seen = new Set<string>();
    while (current) {
      assert(!seen.has(current.id), 'commander cycle');
      seen.add(current.id);
      if (!current.parentId) break;
      const parent = commanders.find((p) => p.id === current!.parentId);
      assert(parent, `missing parent: ${current.parentId}`);
      assert(parent.side === c.side, 'parent side mismatch');
      current = parent;
    }
  }
}
