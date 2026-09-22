/** Explicit opt-in only; sends a small synthetic game scenario, never local chat content. */
import { JevProvider } from '@jev/providers';
import { createObservation, defaultCommanders } from '@jev/demo';
if (!process.env.TYPESAFE_API_KEY) throw Error('Set TYPESAFE_API_KEY in the local environment');
const observation = createObservation();
const provider = new JevProvider({
  apiKey: process.env.TYPESAFE_API_KEY,
  defaultModel: process.env.JEV_MODEL ?? 'jev-latest',
});
const start = Date.now();
try {
  const answer = await provider.evaluate(
    {
      id: 'live-smoke',
      sessionId: observation.sessionId,
      stateVersion: observation.version,
      planVersion: 0,
      purpose: 'doctrine',
      observation,
      commander: defaultCommanders()[0]!,
      candidates: [
        {
          id: 'advance',
          label: '掩护下向游戏目标推进',
          features: { initiative: 1 },
          utility: 1,
          risk: 0.2,
          continuity: 0,
          style: 0,
          total: 0.8,
        },
        {
          id: 'hold',
          label: '原地防守并观察敌方',
          features: { hold: 1 },
          utility: 0.5,
          risk: 0.1,
          continuity: 0,
          style: 0,
          total: 0.4,
        },
      ],
    },
    AbortSignal.timeout(15000),
  );
  console.log(
    JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - start,
      model: answer.model,
      confidence: answer.confidence,
      scores: answer.scores,
    }),
  );
} catch (error) {
  // SDK errors may contain request metadata; never print the error object or request headers.
  console.log(
    JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - start,
      errorType: error instanceof Error ? error.name : 'unknown',
    }),
  );
  process.exitCode = 1;
}
