import { assert, clone, stable } from '@jev/core';
import type { DecisionAnswer, DecisionProvider, DecisionRequest, ModelRecord } from '@jev/core';
export class ReplayProvider implements DecisionProvider {
  readonly id = 'replay';
  private cursor = 0;
  constructor(private records: ModelRecord[]) {}
  async evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionAnswer> {
    assert(!signal.aborted, 'cancelled');
    const record = this.records[this.cursor++];
    assert(record, 'replay exhausted');
    assert(stable(record.request) === stable(request), 'replay request mismatch');
    if (record.error) throw new Error(record.error);
    assert(record.answer, 'missing replay answer');
    return clone(record.answer);
  }
  get consumed() {
    return this.cursor;
  }
}
