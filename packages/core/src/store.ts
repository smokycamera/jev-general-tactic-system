import type { Checkpoint, PlanStore } from './types.js';
import { assert, clone } from './util.js';
export function validateCheckpoint(value: unknown): asserts value is Checkpoint {
  assert(value && typeof value === 'object', 'invalid checkpoint');
  const v = value as Partial<Checkpoint>;
  assert(v.formatVersion === 1, 'unsupported checkpoint version');
  assert(
    typeof v.sessionId === 'string' && Number.isInteger(v.revision) && v.revision! > 0,
    'invalid checkpoint identity',
  );
  assert(
    v.plan && Number.isInteger(v.plan.version) && Array.isArray(v.plan.tasks),
    'invalid checkpoint plan',
  );
  assert(
    Array.isArray(v.commanders) &&
      Array.isArray(v.receipts) &&
      Array.isArray(v.records) &&
      Array.isArray(v.goals) &&
      Array.isArray(v.revisions) &&
      Array.isArray(v.seenEvents),
    'invalid checkpoint collections',
  );
  assert(
    v.progress &&
      typeof v.progress === 'object' &&
      v.metrics &&
      typeof v.paused === 'boolean' &&
      v.host !== undefined,
    'incomplete checkpoint',
  );
  const keys = new Set<string>();
  for (const r of v.receipts) {
    assert(typeof r.key === 'string' && !keys.has(r.key), 'duplicate checkpoint receipt');
    keys.add(r.key);
  }
  if (v.pending)
    assert(
      v.pending.sessionId === v.sessionId && typeof v.pending.key === 'string',
      'invalid pending action',
    );
}
export class MemoryPlanStore implements PlanStore {
  private data = new Map<string, Checkpoint>();
  async load(sessionId: string): Promise<Checkpoint | null> {
    return clone(this.data.get(sessionId) ?? null);
  }
  async save(checkpoint: Checkpoint, expectedRevision: number): Promise<void> {
    validateCheckpoint(checkpoint);
    const current = this.data.get(checkpoint.sessionId);
    assert((current?.revision ?? 0) === expectedRevision, 'checkpoint version conflict');
    assert(checkpoint.revision === expectedRevision + 1, 'checkpoint revision must advance once');
    this.data.set(checkpoint.sessionId, clone(checkpoint));
  }
}
