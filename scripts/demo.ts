import { CommandRuntime, MemoryPlanStore } from '@jev/core';
import { DemoAdapter, createObservation, defaultCommanders } from '@jev/demo';
for (const kind of ['grid', 'regions']) {
  const adapter = new DemoAdapter(createObservation(kind));
  const store = new MemoryPlanStore();
  const runtime = new CommandRuntime({
    adapter,
    store,
    commanders: defaultCommanders(),
    policy: { tickDelayMs: 0 },
  });
  await runtime.start(1000);
  const observation = await adapter.observe();
  console.log(
    JSON.stringify(
      {
        map: kind,
        status: runtime.status,
        winner: observation.winner,
        turn: observation.turn,
        metrics: runtime.state.metrics,
        planVersion: runtime.state.plan.version,
      },
      null,
      2,
    ),
  );
  if (!observation.ended || runtime.status.state === 'stopped') process.exitCode = 1;
}
