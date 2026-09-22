import { assert, deadline, validateGoals, validateNarrativeContext } from '@jev/core';
import { validateContextSelectionRequest, validateContextSelectionAnswer } from '@jev/core';
import type { ContextSelector } from '@jev/core';
import type {
  DecisionRequest,
  DecisionProvider,
  Observation,
  NarrativeMessage,
  TextExtractor,
} from '@jev/core';

function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'expected object');
}
export function validateObservation(value: unknown): asserts value is Observation {
  object(value);
  assert(
    typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      value.sessionId.length <= 4096,
    'invalid session',
  );
  assert(
    Number.isSafeInteger(value.version) &&
      Number(value.version) >= 0 &&
      Number.isSafeInteger(value.turn),
    'invalid observation version',
  );
  assert(
    typeof value.activeSide === 'string' && typeof value.ended === 'boolean',
    'invalid observation side',
  );
  assert(Array.isArray(value.units) && value.units.length <= 500, 'invalid units');
  object(value.map);
  assert(Array.isArray(value.map.locations) && value.map.locations.length <= 10000, 'invalid map');
  for (const unit of value.units) {
    object(unit);
    assert(
      typeof unit.id === 'string' &&
        typeof unit.side === 'string' &&
        typeof unit.location === 'string' &&
        Array.isArray(unit.tags),
      'invalid unit',
    );
    for (const key of ['hp', 'maxHp', 'attack', 'range', 'ap', 'ammo'])
      assert(Number.isFinite(unit[key]), 'invalid unit number');
  }
  for (const location of value.map.locations) {
    object(location);
    assert(
      typeof location.id === 'string' &&
        Array.isArray(location.neighbors) &&
        location.neighbors.every((n) => typeof n === 'string'),
      'invalid location',
    );
    assert(
      Number.isFinite(location.x) && Number.isFinite(location.y) && Number.isFinite(location.cover),
      'invalid location number',
    );
  }
  assert(
    Array.isArray(value.goals) && value.goals.length <= 100 && Array.isArray(value.events),
    'invalid observation collections',
  );
  validateGoals(value.goals, value as unknown as Observation);
}
export function validateDecision(value: unknown): asserts value is DecisionRequest {
  object(value);
  validateObservation(value.observation);
  assert(
    value.sessionId === value.observation.sessionId &&
      value.stateVersion === value.observation.version,
    'decision observation mismatch',
  );
  assert(['family', 'doctrine', 'action'].includes(String(value.purpose)), 'invalid purpose');
  object(value.commander);
  assert(
    value.commander.side === value.observation.activeSide && Array.isArray(value.commander.unitIds),
    'invalid commander',
  );
  assert(
    Array.isArray(value.candidates) &&
      value.candidates.length >= 1 &&
      value.candidates.length <= 64,
    'invalid candidates',
  );
  const ids = new Set<string>();
  for (const candidate of value.candidates) {
    object(candidate);
    assert(
      typeof candidate.id === 'string' && candidate.id.length <= 500 && !ids.has(candidate.id),
      'invalid candidate id',
    );
    ids.add(candidate.id);
    assert(
      typeof candidate.label === 'string' && Number.isFinite(candidate.total),
      'invalid candidate',
    );
  }
}

/** Stateless model gateway. Host facts, commands and saves never live on this server. */
export async function evaluateDecision(
  input: unknown,
  provider: DecisionProvider | undefined,
  signal: AbortSignal,
  timeoutMs = 10000,
) {
  validateDecision(input);
  assert(provider, 'JEV provider is not configured');
  return deadline((s) => provider.evaluate(input, s), timeoutMs, signal);
}
export async function extractContext(
  input: Record<string, unknown>,
  extractor: TextExtractor | undefined,
  signal: AbortSignal,
  timeoutMs = 10000,
) {
  validateObservation(input.observation);
  assert(Array.isArray(input.messages) && input.messages.length <= 100, 'invalid messages');
  for (const message of input.messages) {
    object(message);
    assert(
      typeof message.id === 'string' &&
        typeof message.role === 'string' &&
        typeof message.text === 'string' &&
        message.text.length <= 100000 &&
        message.completed === true,
      'invalid completed message',
    );
  }
  if (!extractor) return { goals: [] };
  const observation = input.observation;
  return validateNarrativeContext(
    await deadline(
      (s) => extractor.extract(input.messages as NarrativeMessage[], observation, s),
      timeoutMs,
      signal,
    ),
    observation,
  );
}

export async function selectContext(
  input: unknown,
  selector: ContextSelector | undefined,
  signal: AbortSignal,
) {
  validateContextSelectionRequest(input);
  assert(selector, 'context selection requires a configured JEV provider');
  const result = await deadline((s) => selector.selectContext(input, s), 10000, signal);
  validateContextSelectionAnswer(result, input);
  return result;
}
