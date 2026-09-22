import { noul, score, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Questions, TypeSafeClientConfig } from '@typesafe-ai/sdk';
import { assert, clamp } from '@jev/core';
import type { DecisionAnswer, DecisionProvider, DecisionRequest } from '@jev/core';
/** Official SDK only; instantiate in a server process, never in the browser. */
export class JevProvider implements DecisionProvider {
  readonly id = 'jev';
  private client: TypeSafeClient;
  constructor(config: TypeSafeClientConfig = {}) {
    this.client = new TypeSafeClient({
      ...config,
      retry: { maxRetries: 0 },
      timeout: 10000,
      logLevel: 'off',
    });
  }
  async evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionAnswer> {
    const questions: Questions = {};
    for (let i = 0; i < request.candidates.length; i++) {
      questions[`benefit_${i}`] = score(
        `仅根据已知游戏状态，评价 candidates[${i}] 的 steps 中目的地、单位分配、依赖顺序及目标。对其 goal（没有时使用请求 goal）推进的帮助有多大？结合 recentActions 判断是否重复无效操作；不要把本地 total 当作结论。`,
        ['无帮助或妨碍', '小幅帮助', '明显推进', '直接达成目标'],
      );
      questions[`risk_${i}`] = noul(
        `候选 candidates[${i}] 是否会使己方游戏单位暴露于 observation 中已经可见的强敌？不要假设未观测敌人。`,
      );
    }
    const response = await this.client.systemOne(
      {
        state: JSON.stringify({
          purpose: request.purpose,
          observation: request.observation,
          commander: request.commander,
          goal: request.goal,
          candidates: request.candidates,
          recentActions: request.recentActions ?? [],
        }),
        questions,
      },
      { signal, retry: { maxRetries: 0 } },
    );
    const scores: Record<string, number> = {};
    let confidence = 0;
    for (let i = 0; i < request.candidates.length; i++) {
      const benefit = response.answers[`benefit_${i}`],
        risk = response.answers[`risk_${i}`];
      assert(benefit?.type === 'score' && risk?.type === 'noul', 'incomplete Jev response');
      assert(
        Number.isFinite(benefit.score) &&
          benefit.score >= 0 &&
          benefit.score <= 3 &&
          Number.isFinite(risk.noul) &&
          risk.noul >= 0 &&
          risk.noul <= 1,
        'invalid Jev values',
      );
      scores[request.candidates[i]!.id] = clamp((benefit.score / 3) * 0.8 + (1 - risk.noul) * 0.2);
      confidence += benefit.confidence;
    }
    return {
      scores,
      confidence: confidence / Math.max(1, request.candidates.length),
      model: response.model,
    };
  }
}
