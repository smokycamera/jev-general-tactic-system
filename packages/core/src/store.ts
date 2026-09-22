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
  if (v.lastModelSelection) {
    const selection = v.lastModelSelection;
    assert(
      typeof selection.model === 'string' &&
        Number.isFinite(selection.confidence) &&
        selection.confidence >= 0 &&
        selection.confidence <= 1 &&
        ['family', 'doctrine', 'action'].includes(selection.purpose) &&
        Number.isSafeInteger(selection.stateVersion) &&
        typeof selection.localId === 'string' &&
        typeof selection.selectedId === 'string',
      'invalid model selection',
    );
  }
  if (v.memory !== undefined) {
    assert(
      v.memory && typeof v.memory === 'object' && !Array.isArray(v.memory),
      'invalid tactical memory',
    );
    for (const memory of Object.values(v.memory)) {
      assert(
        memory &&
          Array.isArray(memory.visited) &&
          memory.visited.length <= 512 &&
          memory.visited.every((id) => typeof id === 'string'),
        'invalid visited locations',
      );
      assert(
        Array.isArray(memory.history) && memory.history.length <= 24,
        'invalid action history',
      );
      for (const entry of memory.history)
        assert(
          entry &&
            typeof entry.key === 'string' &&
            Number.isSafeInteger(entry.turn) &&
            ['succeeded', 'running', 'failed', 'rejected'].includes(entry.outcome) &&
            entry.action &&
            typeof entry.action.id === 'string' &&
            typeof entry.action.unitId === 'string' &&
            typeof entry.action.kind === 'string',
          'invalid action history entry',
        );
    }
  }
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
