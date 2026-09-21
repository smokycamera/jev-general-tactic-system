import type {
  Allocator,
  BattleAdapter,
  BattlePlan,
  Candidate,
  CapabilityProfile,
  Checkpoint,
  Commander,
  Coordinator,
  DecisionAnswer,
  DecisionContext,
  DecisionProvider,
  DecisionRequest,
  DecisionStage,
  Evaluator,
  Goal,
  GoalSource,
  Metrics,
  ModelRecord,
  NarrativeSource,
  Observation,
  PlanPatch,
  PlanStore,
  Revision,
  RuntimePolicy,
  Selector,
  Status,
  Task,
  TaskProgress,
  TextExtractor,
  WorkflowProfile,
} from './types.js';
import {
  DoctrineRegistry,
  PROFILES,
  Registry,
  StyleDimensionRegistry,
  Workflow,
  validateCommanders,
} from './registry.js';
import { defaultDoctrines } from './doctrines.js';
import { defaultStyles } from './styles.js';
import {
  advanceProgress,
  applyPlanPatch,
  assess,
  conditionMet,
  defaultAllocator,
  evaluationContext,
  goalFor,
  taskFromMethod,
} from './planning.js';
import { defaultCoordinator, defaultEvaluator, defaultSelector, scoreAction } from './scoring.js';
import { mergeGoals, narrativeWindow, validateGoals } from './goals.js';
import {
  assert,
  clamp,
  clone,
  deadline,
  delay,
  errorMessage,
  SerialQueue,
  stable,
} from './util.js';
import { validateCheckpoint } from './store.js';
export const DEFAULT_POLICY: RuntimePolicy = {
  mode: 'silent-auto',
  requestTimeoutMs: 10000,
  decisionBudgetMs: 30000,
  failureThreshold: 3,
  cooldownMs: 30000,
  retries: 2,
  retryDelayMs: 25,
  tickDelayMs: 40,
  narrativeWindow: 6,
  narrativeRoles: ['assistant'],
  narrativeMode: 'auto',
};
const metrics = (): Metrics => ({
  decisions: 0,
  actions: 0,
  fallbacks: 0,
  stale: 0,
  approvals: 0,
  evaluations: 0,
  stages: {},
  lastFactors: [],
  lastCandidates: 0,
  maxHorizon: 0,
  lastCoordination: 0,
  lastBranches: 0,
});
export interface RuntimeOptions {
  clock?: { now(): number };
  adapter: BattleAdapter;
  store: PlanStore;
  commanders: Commander[];
  goals?: Goal[];
  policy?: Partial<RuntimePolicy>;
  provider?: DecisionProvider;
  doctrines?: DoctrineRegistry;
  styles?: StyleDimensionRegistry;
  profiles?: Record<string, CapabilityProfile>;
  allocator?: Allocator;
  coordinator?: Coordinator;
  evaluators?: Evaluator[];
  selector?: Selector;
  narrative?: NarrativeSource;
  extractor?: TextExtractor;
  goalSources?: GoalSource[];
  extraStages?: DecisionStage[];
  workflow?: WorkflowProfile;
}
/** One runtime per host battle. Host execution and durable receipts must be atomic. */
export class CommandRuntime {
  private now(): number {
    return this.options.clock?.now() ?? Date.now();
  }
  readonly doctrines: DoctrineRegistry;
  readonly styles: StyleDimensionRegistry;
  readonly profiles: Record<string, CapabilityProfile>;
  readonly policy: RuntimePolicy;
  private queue = new SerialQueue();
  private aborter: AbortController | null = null;
  private epoch = 0;
  private looping = false;
  private initialized = false;
  private plan: BattlePlan = { id: 'pending', version: 0, goals: [], tasks: [], createdTurn: 0 };
  private progress: Record<string, TaskProgress> = {};
  private goals: Goal[];
  private commanders: Commander[];
  private revisions: Revision[] = [];
  private records: ModelRecord[] = [];
  private receipts: Checkpoint['receipts'] = [];
  private pending: Checkpoint['pending'] = null;
  private revision = 0;
  private seenEvents = new Set<string>();
  private paused = false;
  private stats = metrics();
  private narrativeKey = '';
  private failures = 0;
  private cooldownUntil = 0;
  private decisionEnd = 0;
  private changes: Revision[] = [];
  private workflow: Workflow;
  private statusValue: Status = {
    state: 'idle',
    detail: '就绪',
    savedRevision: 0,
    provider: 'local',
    confirmations: 0,
  };
  lastCandidates: Candidate[] = [];
  lastAssignments: DecisionContext['assignments'] = [];
  constructor(private options: RuntimeOptions) {
    this.doctrines = options.doctrines ?? defaultDoctrines();
    this.styles = options.styles ?? defaultStyles();
    this.profiles = options.profiles ?? PROFILES;
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.commanders = clone(options.commanders);
    this.goals = clone(options.goals ?? []);
    validateCommanders(this.commanders, this.styles, this.profiles);
    validateGoals(this.goals);
    assert(this.commanders.length > 0, 'at least one commander required');
    for (const key of [
      'requestTimeoutMs',
      'decisionBudgetMs',
      'failureThreshold',
      'cooldownMs',
      'retryDelayMs',
      'tickDelayMs',
      'narrativeWindow',
      'retries',
    ] as const)
      assert(Number.isInteger(this.policy[key]) && this.policy[key] >= 0, `invalid policy ${key}`);
    assert(
      this.policy.requestTimeoutMs > 0 &&
        this.policy.decisionBudgetMs > 0 &&
        this.policy.failureThreshold > 0,
      'invalid time budget',
    );
    for (const p of Object.values(this.profiles))
      assert(
        p.candidateLimit >= 1 &&
          p.horizon >= 1 &&
          Number.isFinite(p.candidateLimit) &&
          Number.isFinite(p.horizon),
        'invalid capability profile',
      );
    const stages = new Registry<DecisionStage>();
    const add = (
      id: string,
      dependencies: string[],
      inputs: string[],
      outputs: string[],
      run: DecisionStage['run'],
    ) =>
      stages.register({
        id,
        dependencies,
        inputs,
        outputs,
        run,
        version: '1.0.0',
        capabilities: [],
        budgetMs: this.policy.decisionBudgetMs,
        config: {},
      });
    add('goals', [], ['observation'], ['goals'], async (c) => {
      c.goals = mergeGoals(c.goals, c.observation.goals);
      for (const cmd of c.commanders)
        if (!c.goals.some((g) => g.side === cmd.side))
          c.goals = mergeGoals(c.goals, [goalFor(cmd, c.goals)]);
      for (const source of options.goalSources ?? [])
        try {
          const incoming = await deadline(
            () => source.read(c.observation),
            this.policy.requestTimeoutMs,
            c.signal,
          );
          validateGoals(incoming, c.observation);
          c.goals = mergeGoals(c.goals, incoming);
        } catch {
          /* Retain the last valid goal on source failure. */
        }
    });
    add('assessment', ['goals'], ['observation', 'goals'], ['assessment'], async (c) => {
      c.assessment = assess(c.observation, c.observation.activeSide);
    });
    add('plan', ['assessment'], ['assessment', 'goals', 'plan'], ['plan', 'progress'], (c) =>
      this.planDecision(c),
    );
    add('allocate', ['plan'], ['plan', 'progress'], ['assignments'], async (c) => {
      c.assignments = (options.allocator ?? defaultAllocator).allocate(
        c.observation,
        c.commanders,
        c.plan,
        c.progress,
        this.profiles,
      );
    });
    add('candidates', ['allocate'], ['assignments'], ['candidates'], (c) => this.makeCandidates(c));
    add('select', ['candidates'], ['candidates'], ['selected'], (c) => this.selectAction(c));
    for (const stage of options.extraStages ?? []) stages.register(stage);
    this.workflow = new Workflow(
      stages,
      options.workflow ?? {
        id: 'default',
        stages: stages.all().map((s) => s.id),
        capabilities: [],
      },
    );
  }
  get status(): Status {
    return clone(this.statusValue);
  }
  get state() {
    return clone({
      plan: this.plan,
      progress: this.progress,
      commanders: this.commanders,
      goals: this.goals,
      revisions: this.revisions,
      metrics: this.stats,
      records: this.records,
      receipts: this.receipts,
      status: this.statusValue,
      candidates: this.lastCandidates,
      assignments: this.lastAssignments,
    });
  }
  private setStatus(state: Status['state'], detail: string) {
    this.statusValue = { ...this.statusValue, state, detail, savedRevision: this.revision };
  }
  private invalidate() {
    this.epoch++;
    this.aborter?.abort();
  }
  async initialize(): Promise<void> {
    return this.queue.run(async () => {
      if (this.initialized) return;
      const o = await this.options.adapter.observe();
      const saved = await this.options.store.load(o.sessionId);
      if (saved) {
        validateCheckpoint(saved);
        assert(saved.sessionId === o.sessionId, 'checkpoint session mismatch');
        this.revision = saved.revision;
        this.plan = saved.plan;
        this.progress = saved.progress;
        this.commanders = saved.commanders;
        this.goals = mergeGoals(saved.goals, this.goals);
        this.revisions = saved.revisions;
        this.records = saved.records;
        this.receipts = saved.receipts;
        this.pending = saved.pending;
        this.stats = saved.metrics;
        this.seenEvents = new Set(saved.seenEvents);
        this.paused = saved.paused;
        this.narrativeKey = saved.narrativeKey ?? '';
        validateCommanders(this.commanders, this.styles, this.profiles);
      } else {
        this.plan = {
          id: o.sessionId,
          version: 0,
          goals: this.goals,
          tasks: [],
          createdTurn: o.turn,
        };
      }
      this.initialized = true;
      this.setStatus(this.paused ? 'paused' : 'idle', saved ? '已恢复计划并同步宿主' : '就绪');
      if (this.pending) await this.reconcilePending();
    });
  }
  async exportCheckpoint(): Promise<Checkpoint> {
    return this.queue.run(() => this.checkpoint(this.revision));
  }
  private async checkpoint(revision: number): Promise<Checkpoint> {
    return {
      formatVersion: 1,
      sessionId: this.plan.id,
      revision,
      plan: clone(this.plan),
      progress: clone(this.progress),
      commanders: clone(this.commanders),
      goals: clone(this.goals),
      revisions: clone(this.revisions),
      records: clone(this.records),
      receipts: clone(this.receipts),
      pending: clone(this.pending),
      host: await this.options.adapter.snapshot(),
      metrics: clone(this.stats),
      seenEvents: [...this.seenEvents],
      paused: this.paused,
      narrativeKey: this.narrativeKey,
    };
  }
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let error: unknown;
    for (let i = 0; i <= this.policy.retries; i++) {
      try {
        return await fn();
      } catch (e) {
        error = e;
        if (i < this.policy.retries) await delay(this.policy.retryDelayMs * (i + 1));
      }
    }
    throw error;
  }
  private async persist(): Promise<void> {
    const cp = await this.checkpoint(this.revision + 1);
    await this.retry(async () => {
      try {
        await this.options.store.save(cp, this.revision);
      } catch (error) {
        const actual = await this.options.store.load(cp.sessionId);
        if (actual && stable(actual) === stable(cp)) return;
        throw error;
      }
    });
    this.revision = cp.revision;
    this.statusValue.savedRevision = this.revision;
  }
  private async reconcilePending(): Promise<void> {
    if (!this.pending) return;
    const envelope = this.pending;
    let receipt = await this.options.adapter.receipt(envelope.key);
    if (!receipt) {
      const o = await this.options.adapter.observe();
      if (o.version !== envelope.stateVersion) {
        this.pending = null;
        this.stats.stale++;
        await this.persist();
        return;
      }
      receipt = await this.retry(() =>
        deadline(() => this.options.adapter.execute(envelope), this.policy.requestTimeoutMs),
      );
    }
    assert(receipt.key === envelope.key, 'receipt key mismatch');
    if (!this.receipts.some((r) => r.key === receipt!.key)) {
      this.receipts.push(receipt);
      if (receipt.applied) {
        this.stats.actions++;
        for (const t of this.plan.tasks)
          if (t.level === 'tactics' && t.unitIds.includes(envelope.action.unitId)) {
            const p = this.progress[t.id];
            if (p) p.actions++;
          }
      }
    }
    this.pending = null;
    await this.persist();
  }
  async step(): Promise<Status> {
    if (!this.initialized) await this.initialize();
    return this.queue.run(() => this.stepInside());
  }
  private async stepInside(): Promise<Status> {
    if (this.paused) {
      this.setStatus('paused', '已暂停自动控制');
      return this.status;
    }
    this.aborter = new AbortController();
    const signal = this.aborter.signal;
    const epoch = this.epoch;
    this.decisionEnd = this.now() + this.policy.decisionBudgetMs;
    this.changes = [];
    try {
      await this.reconcilePending();
      const o = await this.options.adapter.observe();
      assert(o.sessionId === this.plan.id, 'host changed session');
      if (o.ended) {
        this.progress = advanceProgress(this.plan, this.progress, o);
        this.setStatus('ended', '战斗结束');
        await this.persist();
        return this.status;
      }
      if (!this.commanders.some((c) => c.side === o.activeSide)) {
        this.setStatus('waiting', '等待宿主激活授权阵营');
        return this.status;
      }
      for (const cmd of this.commanders)
        for (const id of cmd.unitIds) {
          const unit = o.units.find((u) => u.id === id);
          assert(!unit || unit.side === cmd.side, 'host unit ownership mismatch');
        }
      const context: DecisionContext = {
        observation: o,
        commanders: clone(this.commanders),
        goals: clone(this.goals),
        plan: clone(this.plan),
        progress: clone(this.progress),
        assignments: [],
        assessment: assess(o, o.activeSide),
        candidates: [],
        signal,
        trace: [],
      };
      this.setStatus('running', '自动指挥中');
      if (this.policy.narrativeMode === 'auto') await this.extractNarrative(context);
      await this.workflow.runDraft(context);
      const now = await this.options.adapter.observe();
      if (
        epoch !== this.epoch ||
        signal.aborted ||
        now.version !== o.version ||
        now.sessionId !== o.sessionId
      ) {
        this.stats.stale++;
        this.setStatus(this.paused ? 'paused' : 'idle', '已丢弃过期决策');
        return this.status;
      }
      this.plan = context.plan;
      this.progress = context.progress;
      this.goals = context.goals;
      this.revisions.push(...this.changes);
      o.events.forEach((e) => this.seenEvents.add(e.id));
      this.lastCandidates = context.candidates;
      this.lastAssignments = context.assignments;
      this.stats.decisions++;
      for (const s of context.trace) this.stats.stages[s] = (this.stats.stages[s] ?? 0) + 1;
      if (!context.selected?.action) {
        this.setStatus('waiting', '没有合法自动行动，等待宿主事件');
        await this.persist();
        return this.status;
      }
      const action = context.selected.action;
      const legal = await this.options.adapter.legalActions(now, [action.unitId]);
      assert(
        legal.some((a) => stable(a) === stable(action)),
        'action became illegal',
      );
      // Persist an intent BEFORE submitting. Retries reuse this exact idempotency key.
      this.pending = {
        sessionId: o.sessionId,
        stateVersion: o.version,
        planVersion: this.plan.version,
        key: `${o.sessionId}:${o.version}:${this.plan.version}:${action.id}`,
        action,
      };
      await this.persist();
      if (epoch !== this.epoch || signal.aborted) {
        this.pending = null;
        await this.persist();
        return this.status;
      }
      await this.reconcilePending();
      const after = await this.options.adapter.observe();
      this.setStatus(
        after.ended ? 'ended' : this.failures ? 'degraded' : 'idle',
        after.ended ? '战斗结束' : this.failures ? '使用本地规则继续' : '行动已结算并保存',
      );
      return this.status;
    } catch (error) {
      if (signal.aborted || epoch !== this.epoch) {
        this.stats.stale++;
        this.setStatus(this.paused ? 'paused' : 'idle', '自动决策已取消');
      } else {
        this.setStatus('stopped', `控制器已停止提交：${errorMessage(error)}`);
      }
      return this.status;
    } finally {
      this.aborter = null;
    }
  }
  async singleStep(): Promise<Status> {
    if (!this.initialized) await this.initialize();
    await this.pause();
    return this.queue.run(async () => {
      this.paused = false;
      try {
        await this.stepInside();
      } finally {
        this.paused = true;
        if (this.statusValue.state !== 'ended' && this.statusValue.state !== 'stopped')
          this.setStatus('paused', '单步已完成');
        await this.persist();
      }
      return this.status;
    });
  }
  async start(maxActions = 10000): Promise<Status> {
    if (this.looping) return this.status;
    this.paused = false;
    this.looping = true;
    try {
      for (let i = 0; i < maxActions && !this.paused; i++) {
        const s = await this.step();
        if (['ended', 'waiting', 'stopped', 'paused'].includes(s.state)) break;
        await delay(this.policy.tickDelayMs);
      }
      return this.status;
    } finally {
      this.looping = false;
    }
  }
  /** A host event wakes a waiting controller; no approval step is involved. */
  notify(): void {
    if (!this.paused && !this.looping)
      void this.start().catch((e) => this.setStatus('stopped', errorMessage(e)));
  }
  async pause(): Promise<void> {
    this.paused = true;
    this.invalidate();
    return this.queue.run(async () => {
      this.setStatus('paused', '已暂停自动控制');
      if (this.initialized) await this.persist();
    });
  }
  /** Stop this process while preserving whether the player explicitly paused the session. */
  async shutdown(): Promise<void> {
    const playerPaused = this.paused;
    this.paused = true;
    this.invalidate();
    return this.queue.run(async () => {
      try {
        this.paused = playerPaused;
        if (this.initialized) await this.persist();
      } finally {
        this.paused = true;
      }
    });
  }
  async resume(): Promise<Status> {
    this.paused = false;
    return this.start();
  }
  async updateGoals(goals: Goal[]): Promise<void> {
    validateGoals(goals);
    this.invalidate();
    return this.queue.run(async () => {
      const o = await this.options.adapter.observe();
      validateGoals(goals, o);
      this.goals = mergeGoals(this.goals, goals);
      if (this.initialized) await this.persist();
    });
  }
  async updateCommander(id: string, update: Pick<Commander, 'ability' | 'style'>): Promise<void> {
    this.invalidate();
    return this.queue.run(async () => {
      const next = clone(this.commanders);
      const c = next.find((c) => c.id === id);
      assert(c, 'unknown commander');
      Object.assign(c, update);
      validateCommanders(next, this.styles, this.profiles);
      this.commanders = next;
      this.seenEvents.clear();
      await this.persist();
    });
  }
  async patch(patch: PlanPatch): Promise<void> {
    this.invalidate();
    return this.queue.run(async () => {
      for (const t of patch.replaceTasks ?? []) {
        this.doctrines.get(t.doctrineId);
        const c = this.commanders.find((c) => c.id === t.commanderId);
        assert(c && t.unitIds.every((id) => c.unitIds.includes(id)), 'invalid task ownership');
        assert(t.phases.length > 0, 'missing task phases');
      }
      const o = await this.options.adapter.observe();
      const next = applyPlanPatch(this.plan, this.progress, patch, o.turn);
      this.plan = next.plan;
      this.progress = next.progress;
      this.revisions.push(next.revision);
      await this.persist();
    });
  }
  async restorePlan(plan: BattlePlan): Promise<void> {
    await this.patch({
      baseVersion: this.plan.version,
      source: 'restore',
      reason: '依据当前战况恢复历史方案',
      events: [],
      scope: this.commanders.map((c) => c.id),
      replaceTasks: plan.tasks
        .filter((t) => t.level === 'tactics')
        .map((t) => ({
          ...clone(t),
          id: `${t.commanderId}-restored-v${this.plan.version + 1}`,
          locked: false,
        })),
    });
  }
  async manual(actionId: string): Promise<void> {
    this.invalidate();
    return this.queue.run(async () => {
      await this.reconcilePending();
      const o = await this.options.adapter.observe();
      const ids = this.commanders.filter((c) => c.side === o.activeSide).flatMap((c) => c.unitIds);
      const action = (await this.options.adapter.legalActions(o, ids)).find(
        (a) => a.id === actionId,
      );
      assert(action, 'manual action not legal or authorized');
      for (const task of this.plan.tasks)
        if (task.level === 'tactics' && task.unitIds.includes(action.unitId)) {
          task.unitIds = task.unitIds.filter((id) => id !== action.unitId);
        }
      this.plan.version++;
      this.pending = {
        sessionId: o.sessionId,
        stateVersion: o.version,
        planVersion: this.plan.version,
        key: `${o.sessionId}:${o.version}:manual:${action.id}`,
        action,
      };
      await this.persist();
      await this.reconcilePending();
    });
  }
  async scanNarrative(): Promise<void> {
    this.invalidate();
    return this.queue.run(async () => {
      const o = await this.options.adapter.observe();
      this.narrativeKey = '';
      const c = { observation: o, goals: clone(this.goals), signal: new AbortController().signal };
      await this.extractNarrative(c);
      this.goals = c.goals;
      await this.persist();
    });
  }
  private async extractNarrative(
    c: Pick<DecisionContext, 'observation' | 'goals' | 'signal'>,
  ): Promise<void> {
    if (!this.options.narrative || !this.options.extractor || this.policy.narrativeMode === 'off')
      return;
    try {
      const messages = narrativeWindow(
        await this.options.narrative.recent(),
        this.policy.narrativeWindow,
        this.policy.narrativeRoles,
      );
      const key = stable(messages);
      if (!messages.length || key === this.narrativeKey) return;
      const goals = await deadline(
        (s) => this.options.extractor!.extract(messages, c.observation, s),
        this.policy.requestTimeoutMs,
        c.signal,
      );
      const normalized = goals.map((g) => ({ ...g, source: 'narrative' as const }));
      validateGoals(normalized, c.observation);
      c.goals = mergeGoals(c.goals, normalized);
      if (!c.signal.aborted) this.narrativeKey = key;
    } catch {
      /* Missing or invalid narrative never blocks a host decision. */
    }
  }
  private async choose(
    request: DecisionRequest,
    signal: AbortSignal,
  ): Promise<Candidate | undefined> {
    const candidates = request.candidates;
    const local = (this.options.selector ?? defaultSelector).select(candidates);
    if (!this.options.provider || candidates.length < 2 || this.now() < this.cooldownUntil) {
      this.statusValue.provider = 'local';
      return local;
    }
    const remaining = this.decisionEnd - this.now() - 15;
    if (remaining <= 0) {
      this.stats.fallbacks++;
      return local;
    }
    try {
      const answer = await deadline(
        (s) => this.options.provider!.evaluate(clone(request), s),
        Math.min(remaining, this.policy.requestTimeoutMs),
        signal,
      );
      this.validateAnswer(answer, candidates);
      if (signal.aborted) throw new Error('cancelled');
      this.records.push({ request: clone(request), answer: clone(answer) });
      this.failures = 0;
      this.cooldownUntil = 0;
      this.statusValue.provider = answer.model;
      // Low confidence retains the locally evaluated plan instead of asking the player.
      if (answer.confidence < 0.55) return local;
      return (this.options.selector ?? defaultSelector).select(
        candidates.map((c) => ({
          ...c,
          total: c.total + clamp(answer.scores[c.id] ?? 0.5) * 3 * answer.confidence,
        })),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      this.failures++;
      this.stats.fallbacks++;
      this.records.push({ request: clone(request), error: errorMessage(error).slice(0, 300) });
      if (this.failures >= this.policy.failureThreshold)
        this.cooldownUntil = this.now() + this.policy.cooldownMs;
      this.statusValue.provider = 'local';
      return local;
    }
  }
  private validateAnswer(answer: DecisionAnswer, candidates: Candidate[]) {
    assert(
      Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1,
      'invalid model confidence',
    );
    assert(typeof answer.model === 'string', 'invalid model id');
    assert(answer.scores && typeof answer.scores === 'object', 'invalid model scores');
    for (const c of candidates)
      assert(
        Number.isFinite(answer.scores[c.id]) &&
          answer.scores[c.id]! >= 0 &&
          answer.scores[c.id]! <= 1,
        `invalid score: ${c.id}`,
      );
  }
  private async planDecision(c: DecisionContext): Promise<void> {
    c.progress = advanceProgress(c.plan, c.progress, c.observation);
    const changedGoals = stable(c.goals) !== stable(c.plan.goals);
    const freshEvents = c.observation.events.filter((e) => !this.seenEvents.has(e.id));
    const replacements: Task[] = [];
    const scope: string[] = [];
    for (const commander of c.commanders) {
      const context = evaluationContext(
        c.observation,
        commander,
        this.profiles[commander.ability]!,
        c.goals,
      );
      const old = c.plan.tasks.find((t) => t.level === 'tactics' && t.commanderId === commander.id);
      const progress = old ? c.progress[old.id] : undefined;
      const phase = old?.phases[progress?.phase ?? 0];
      const strength = c.observation.units
        .filter((u) => commander.unitIds.includes(u.id))
        .reduce((s, u) => s + u.hp, 0);
      if (old && strength === 0) {
        if (progress) progress.status = 'completed';
        continue;
      }
      const failure =
        old &&
        phase &&
        progress &&
        strength < (old.strengthAtCreation ?? Infinity) * 0.75 &&
        conditionMet(phase.abort, c.observation, old, progress, context.goal);
      const affected = freshEvents.some(
        (e) =>
          ['loss', 'blocked', 'goal'].includes(e.kind) &&
          (!e.unitIds?.length || e.unitIds.some((id) => commander.unitIds.includes(id))),
      );
      const changedCommander =
        old?.configurationKey !==
        stable({ ability: commander.ability, style: commander.style, profile: context.profile });
      const changedSideGoals =
        stable(c.goals.filter((goal) => goal.side === commander.side)) !==
        stable(c.plan.goals.filter((goal) => goal.side === commander.side));
      if (old?.locked || (old && !changedSideGoals && !affected && !failure && !changedCommander))
        continue;
      const methods = this.doctrines.all().filter((m) => m.applicable(context));
      assert(methods.length > 0, 'no applicable doctrine');
      const methodCandidates = methods.map((m) => {
        const utility =
          m.score(context) +
          (context.goal.kind === 'withdraw' && m.family !== 'withdraw'
            ? -8
            : context.goal.kind === 'defend' && m.family === 'attack'
              ? -3
              : 0);
        const style = this.styles.score(m.features, commander.style);
        return {
          id: m.id,
          label: m.label,
          features: m.features,
          utility,
          risk: 0,
          continuity: m.id === old?.doctrineId && !failure ? 1 : 0,
          style,
          total: utility + style + (m.id === old?.doctrineId && !failure ? 1 : 0),
        };
      });
      const families = [...new Set(methods.map((m) => m.family))]
        .map((family) => {
          const top = methodCandidates
            .filter((m) => this.doctrines.get(m.id).family === family)
            .sort((a, b) => b.total - a.total)[0]!;
          return { ...top, id: family, label: family };
        })
        .sort((a, b) => b.total - a.total)
        .slice(0, context.profile.candidateLimit);
      const base = {
        sessionId: c.observation.sessionId,
        stateVersion: c.observation.version,
        planVersion: c.plan.version,
        observation: c.observation,
        commander,
      };
      const family = await this.choose(
        {
          ...base,
          id: `${c.observation.version}:${commander.id}:family`,
          purpose: 'family',
          candidates: families,
        },
        c.signal,
      );
      const choices = methodCandidates
        .filter((m) => this.doctrines.get(m.id).family === (family?.id ?? families[0]!.id))
        .sort((a, b) => b.total - a.total)
        .slice(0, context.profile.candidateLimit);
      let picked = await this.choose(
        {
          ...base,
          id: `${c.observation.version}:${commander.id}:doctrine`,
          purpose: 'doctrine',
          candidates: choices,
        },
        c.signal,
      );
      if (failure && old?.alternatives.length) {
        const alternative = choices.find((m) => old.alternatives.includes(m.id));
        if (alternative) picked = alternative;
      }
      const method = this.doctrines.get(picked!.id);
      const task = taskFromMethod(
        `${commander.id}-v${c.plan.version + 1}`,
        commander,
        context.goal,
        c.plan.version + 1,
        method,
        context,
        methodCandidates
          .filter((m) => m.id !== method.id)
          .sort((a, b) => b.total - a.total)
          .slice(0, context.profile.branches)
          .map((m) => m.id),
      );
      replacements.push(task);
      scope.push(commander.id);
      this.stats.maxHorizon = Math.max(this.stats.maxHorizon, task.phases.length);
      this.stats.lastBranches = task.alternatives.length;
    }
    if (replacements.length) {
      const result = applyPlanPatch(
        c.plan,
        c.progress,
        {
          baseVersion: c.plan.version,
          source: changedGoals ? 'host' : 'ai',
          reason:
            c.plan.version === 0
              ? '生成总计划'
              : changedGoals
                ? '目标更新'
                : '局部态势变化，修复受影响任务',
          events: freshEvents.map((e) => e.id),
          scope,
          replaceTasks: replacements,
        },
        c.observation.turn,
      );
      c.plan = result.plan;
      c.progress = result.progress;
      this.changes.push(result.revision);
    }
    c.plan.goals = clone(c.goals);
    if (!c.plan.tasks.some((t) => t.level === 'strategy')) {
      const template = c.plan.tasks.find((t) => t.level === 'tactics')!;
      for (const side of new Set(c.commanders.map((cmd) => cmd.side))) {
        const root = c.commanders.find((cmd) => cmd.side === side && !cmd.parentId)!;
        const strategy: Task = {
          ...clone(template),
          id: `strategy-${side}`,
          side,
          level: 'strategy',
          commanderId: root.id,
          goalId: goalFor(root, c.goals).id,
          unitIds: [],
          phases: [],
          alternatives: [],
        };
        delete strategy.parentId;
        c.plan.tasks.unshift(strategy);
      }
      for (const cmd of c.commanders)
        c.plan.tasks.push({
          ...clone(template),
          id: `campaign-${cmd.id}`,
          side: cmd.side,
          parentId: cmd.parentId ? `campaign-${cmd.parentId}` : `strategy-${cmd.side}`,
          level: 'campaign',
          commanderId: cmd.id,
          goalId: goalFor(cmd, c.goals).id,
          unitIds: [],
          phases: [],
          alternatives: [],
        });
    }
  }
  private async makeCandidates(c: DecisionContext): Promise<void> {
    const authorized = c.commanders
      .filter((cmd) => cmd.side === c.observation.activeSide)
      .flatMap((cmd) => cmd.unitIds);
    const raw = await this.options.adapter.legalActions(c.observation, authorized);
    const legal = (this.options.coordinator ?? defaultCoordinator).filter(raw, c);
    c.candidates = [];
    for (const commander of c.commanders.filter((cmd) => cmd.side === c.observation.activeSide)) {
      const context = evaluationContext(
        c.observation,
        commander,
        this.profiles[commander.ability]!,
        c.goals,
      );
      const task = c.plan.tasks.find(
        (t) => t.level === 'tactics' && t.commanderId === commander.id,
      );
      if (!task) continue;
      context.task = task;
      const method = this.doctrines.get(task.doctrineId);
      const scored = legal
        .filter((a) => commander.unitIds.includes(a.unitId) && task.unitIds.includes(a.unitId))
        .map((a) => {
          const assignment = c.assignments.find((r) => r.unitId === a.unitId);
          return scoreAction(
            a,
            { ...context, ...(assignment ? { assignment } : {}) },
            method,
            this.styles,
            this.options.evaluators ?? [defaultEvaluator],
          );
        })
        .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
      c.candidates.push(...scored.slice(0, context.profile.candidateLimit));
      this.stats.evaluations += scored.length;
      this.stats.lastFactors = context.profile.factors;
      this.stats.lastCoordination = context.profile.coordination;
    }
    this.stats.lastCandidates = c.candidates.length;
  }
  private async selectAction(c: DecisionContext): Promise<void> {
    const commander = c.commanders.find((cmd) => cmd.side === c.observation.activeSide)!;
    const selected = await this.choose(
      {
        id: `${c.observation.version}:action`,
        sessionId: c.observation.sessionId,
        stateVersion: c.observation.version,
        planVersion: c.plan.version,
        purpose: 'action',
        observation: c.observation,
        commander,
        candidates: c.candidates,
      },
      c.signal,
    );
    if (selected) c.selected = selected;
  }
}
