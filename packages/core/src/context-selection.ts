import type { Json, NarrativeMessage } from './types.js';
import { assert } from './util.js';

/** Host-owned configuration choices. The model cannot invent host rules or parameters. */
export interface ContextField {
  id: string;
  question: string;
  options: Record<string, string>;
}
export interface ContextSelectionRequest {
  messages: NarrativeMessage[];
  state: Json;
  fields: ContextField[];
}
export interface ContextSelectionAnswer {
  model: string;
  selections: Record<string, { value: string; confidence: number }>;
}
export interface ContextSelector {
  selectContext(
    request: ContextSelectionRequest,
    signal: AbortSignal,
  ): Promise<ContextSelectionAnswer>;
}
export function validateContextSelectionRequest(
  value: unknown,
): asserts value is ContextSelectionRequest {
  const r = value as ContextSelectionRequest;
  assert(r && typeof r === 'object' && r.state !== undefined, 'invalid context selection');
  assert(Array.isArray(r.messages) && r.messages.length <= 100, 'invalid context messages');
  for (const m of r.messages)
    assert(
      m &&
        typeof m.id === 'string' &&
        typeof m.role === 'string' &&
        typeof m.text === 'string' &&
        m.text.length <= 100000 &&
        m.completed === true,
      'invalid completed message',
    );
  assert(
    Array.isArray(r.fields) && r.fields.length > 0 && r.fields.length <= 32,
    'invalid context fields',
  );
  const ids = new Set<string>();
  for (const f of r.fields) {
    assert(
      f && typeof f.id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(f.id) && !ids.has(f.id),
      'invalid field id',
    );
    ids.add(f.id);
    assert(typeof f.question === 'string' && f.question.length <= 4000, 'invalid context question');
    assert(
      f.options && typeof f.options === 'object' && !Array.isArray(f.options),
      'invalid field options',
    );
    const options = Object.entries(f.options);
    assert(
      options.length >= 2 &&
        options.length <= 32 &&
        options.every(
          ([id, label]) =>
            /^[a-z][a-z0-9_-]{0,63}$/.test(id) && typeof label === 'string' && label.length <= 2000,
        ),
      'invalid field option',
    );
  }
}
export function validateContextSelectionAnswer(
  value: unknown,
  request: ContextSelectionRequest,
): asserts value is ContextSelectionAnswer {
  const a = value as ContextSelectionAnswer;
  assert(
    a && typeof a.model === 'string' && a.selections && typeof a.selections === 'object',
    'invalid context answer',
  );
  for (const f of request.fields) {
    const s = a.selections[f.id];
    assert(
      s &&
        typeof s.value === 'string' &&
        Object.hasOwn(f.options, s.value) &&
        Number.isFinite(s.confidence) &&
        s.confidence >= 0 &&
        s.confidence <= 1,
      'invalid context selection: ' + f.id,
    );
  }
}
