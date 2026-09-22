import type {
  CapabilityResolver,
  ExecutionPolicy,
  HtnMethod,
  TaskNetwork,
  TaskOperator,
  TaskPlanner,
  TaskExecutor,
  TacticalModifier,
  TacticCategory,
} from './execution-types.js';
import { defaultCapabilityResolver, supports, isAction } from './capabilities.js';
import { HtnPlanner, orderedTasks } from './htn.js';
import { defaultOperators, defaultHtnMethods } from './operators.js';
import { NetworkExecutor, recordExecution, syncExecutionOrders, STEP_LABELS } from './execution.js';
import { defaultCategories, defaultModifiers } from './tactics.js';
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
  NarrativeContext,
  NarrativeContextPolicy,
  NarrativeTrigger,
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
  resolveNarrativePolicy,
  shouldScanNarrative,
  validateNarrativeContext,
} from './narrative.js';
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
import { rememberLocations, resolveTarget, targetIntent } from './targeting.js';
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
  maxModelCallsPerDecision: 2,
  modelActionMode: 'local',
};
export const MAX_MODEL_CALLS_PER_DECISION = 10;
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
  capabilityResolver?: CapabilityResolver;
  categories?: Registry<TacticCategory>;
  modifiers?: Registry<TacticalModifier>;
  operators?: Registry<TaskOperator>;
  methods?: Registry<HtnMethod>;
  taskPlanner?: TaskPlanner;
  taskExecutor?: TaskExecutor;
  executionPolicy?: Partial<ExecutionPolicy>;
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
  readonly categories: Registry<TacticCategory>;
  readonly modifiers: Registry<TacticalModifier>;
  readonly operators: Registry<TaskOperator>;
  readonly methods: Registry<HtnMethod>;
  readonly capabilityResolver: CapabilityResolver;
  private taskPlanner: TaskPlanner;
  private taskExecutor: TaskExecutor;
  private modelCalls = 0;
  private activeOrders: { key: string; unitId: string }[] = [];
  readonly styles: StyleDimensionRegistry;
  readonly profiles: Record<string, CapabilityProfile>;
  readonly policy: RuntimePolicy;
  private readonly narrativePolicy: NarrativeContextPolicy;
  private queue = new SerialQueue();
  private aborter: AbortController | null = null;
  private epoch = 0;
  private controlVersion = 0;
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
  private narrativeContext: NarrativeContext | undefined;
  private memory: NonNullable<Checkpoint['memory']> = Object.create(null);
  private lastModelSelection: Checkpoint['lastModelSelection'];
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
    if (!this.doctrines.has('hold-position'))
      this.doctrines.register(defaultDoctrines().get('hold-position'));
    this.categories = options.categories ?? defaultCategories();
    orderedTasks(
      this.categories.all().map((category) => ({
        id: category.id,
        after: category.parentId ? [category.parentId] : [],
      })),
    );
    this.modifiers = options.modifiers ?? defaultModifiers();
    this.operators = options.operators ?? defaultOperators();
    this.methods = options.methods ?? defaultHtnMethods();
    this.capabilityResolver = options.capabilityResolver ?? defaultCapabilityResolver;
    this.taskPlanner = options.taskPlanner ?? new HtnPlanner(this.operators, this.methods);
    this.taskExecutor =
      options.taskExecutor ?? new NetworkExecutor(this.operators, options.executionPolicy);
    this.styles = options.styles ?? defaultStyles();
    this.profiles = options.profiles ?? PROFILES;
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.policy.maxModelCallsPerDecision = Math.min(
      this.policy.maxModelCallsPerDecision,
      MAX_MODEL_CALLS_PER_DECISION,
    );
    this.narrativePolicy = resolveNarrativePolicy(this.policy);
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
      'maxModelCallsPerDecision',
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
      activeOrders: this.activeOrders,
      lastModelSelection: this.lastModelSelection,
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
        this.narrativeContext = saved.narrativeContext;
        this.activeOrders = saved.activeOrders ?? [];
        this.memory = saved.memory ?? Object.create(null);
        this.lastModelSelection = saved.lastModelSelection;
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
      ...(this.narrativeContext ? { narrativeContext: clone(this.narrativeContext) } : {}),
      activeOrders: clone(this.activeOrders),
      memory: clone(this.memory),
      ...(this.lastModelSelection ? { lastModelSelection: clone(this.lastModelSelection) } : {}),
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
  private async reconcilePending(): Promise<boolean | undefined> {
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
      const observation = await this.options.adapter.observe();
      const side = this.commanders.find((c) => c.unitIds.includes(envelope.action.unitId))?.side;
      if (side) {
        const memory = this.memoryFor(side);
        memory.history.push({
          key: envelope.key,
          turn: envelope.turn ?? observation.turn,
          action: clone(envelope.action),
          outcome: receipt.applied ? (receipt.execution ?? 'succeeded') : 'rejected',
        });
        memory.history = memory.history.slice(-24);
      }
      if (receipt.applied && receipt.execution === 'running')
        this.activeOrders.push({ key: receipt.key, unitId: envelope.action.unitId });
      if (receipt.applied) this.stats.actions++;
      for (const t of this.plan.tasks)
        if (t.level === 'tactics' && t.unitIds.includes(envelope.action.unitId)) {
          const p = this.progress[t.id];
          if (p) {
            if (receipt.applied) p.actions++;
            const commander = this.commanders.find((c) => c.id === t.commanderId)!;
            if (envelope.taskId === t.id)
              recordExecution(
                p,
                envelope,
                receipt,
                this.context(await this.options.adapter.observe(), commander, this.goals),
              );
          }
        }
    }
    this.pending = null;
    await this.persist();
    return receipt.applied;
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
    this.modelCalls = 0;
    try {
      await this.reconcilePending();
      const o = await this.options.adapter.observe();
      if (this.narrativeContext) o.narrativeContext = clone(this.narrativeContext);
      for (const memory of Object.values(this.memory))
        for (const action of memory.history)
          if (
            action.outcome === 'running' &&
            ['succeeded', 'failed'].includes(o.orders?.[action.key] ?? '')
          )
            action.outcome = o.orders![action.key] as 'succeeded' | 'failed';
      for (const progress of Object.values(this.progress)) syncExecutionOrders(progress, o);
      this.activeOrders = this.activeOrders.filter(
        (a) => !['succeeded', 'failed'].includes(o.orders?.[a.key] ?? 'running'),
      );
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
      rememberLocations(this.memoryFor(o.activeSide), o, o.activeSide);
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
      if (this.narrativePolicy.mode === 'auto')
        await this.extractNarrative(context, this.narrativeKey ? 'message-change' : 'battle-start');
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
      if (context.narrativeKey !== undefined) this.narrativeKey = context.narrativeKey;
      this.narrativeContext = context.observation.narrativeContext;
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
        turn: o.turn,
        sessionId: o.sessionId,
        stateVersion: o.version,
        planVersion: this.plan.version,
        key: `${o.sessionId}:${o.version}:${this.plan.version}:${action.id}`,
        action,
        ...(context.selected.taskId ? { taskId: context.selected.taskId } : {}),
        ...(context.selected.stepId ? { stepId: context.selected.stepId } : {}),
      };
      await this.persist();
      if (epoch !== this.epoch || signal.aborted) {
        this.pending = null;
        await this.persist();
        return this.status;
      }
      const applied = await this.reconcilePending();
      const after = await this.options.adapter.observe();
      this.setStatus(
        after.ended ? 'ended' : applied === false ? 'waiting' : this.failures ? 'degraded' : 'idle',
        after.ended
          ? '战斗结束'
          : applied === false
            ? '宿主拒绝动作，等待战况更新'
            : this.failures
              ? '使用本地规则继续'
              : '行动已结算并保存',
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
    const controlVersion = this.controlVersion + 1;
    await this.pause();
    return this.queue.run(async () => {
      if (controlVersion !== this.controlVersion) return this.status;
      this.paused = false;
      try {
        await this.stepInside();
      } finally {
        // A later start/pause command owns the desired mode, even while this step settles.
        if (controlVersion === this.controlVersion) this.paused = true;
        if (
          this.paused &&
          this.statusValue.state !== 'ended' &&
          this.statusValue.state !== 'stopped'
        )
          this.setStatus('paused', '单步已完成');
        await this.persist();
      }
      return this.status;
    });
  }
  async start(maxActions = 10000): Promise<Status> {
    if (!this.initialized) await this.initialize();
    this.controlVersion++;
    this.paused = false;
    if (this.looping) return this.status;
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
    this.controlVersion++;
    this.paused = true;
    this.invalidate();
    return this.queue.run(async () => {
      this.setStatus('paused', '已暂停自动控制');
      if (this.initialized) await this.persist();
    });
  }
  /** Stop this process while preserving whether the player explicitly paused the session. */
  async shutdown(): Promise<void> {
    this.controlVersion++;
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
  async updateCommander(
    id: string,
    update: Pick<Commander, 'ability' | 'style'> & Partial<Pick<Commander, 'tactics'>>,
  ): Promise<void> {
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
        if (t.network) {
          orderedTasks(t.network.steps);
          for (const step of t.network.steps) {
            this.operators.get(step.task);
            assert(
              step.unitIds.every((id) => t.unitIds.includes(id)),
              'invalid step ownership',
            );
          }
        }
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
        turn: o.turn,
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
    if (!this.initialized) await this.initialize();
    this.invalidate();
    return this.queue.run(async () => {
      const o = await this.options.adapter.observe();
      const epoch = this.epoch;
      this.aborter = new AbortController();
      this.modelCalls = 0;
      this.decisionEnd = this.now() + this.policy.decisionBudgetMs;
      const c: Pick<DecisionContext, 'observation' | 'goals' | 'signal' | 'narrativeKey'> = {
        observation: o,
        goals: clone(this.goals),
        signal: this.aborter.signal,
      };
      await this.extractNarrative(c, 'manual');
      if (
        c.signal.aborted ||
        epoch !== this.epoch ||
        (await this.options.adapter.observe()).version !== o.version
      )
        return;
      this.goals = c.goals;
      if (c.narrativeKey !== undefined) this.narrativeKey = c.narrativeKey;
      this.narrativeContext = c.observation.narrativeContext ?? this.narrativeContext;
      await this.persist();
    });
  }
  private async extractNarrative(
    c: Pick<DecisionContext, 'observation' | 'goals' | 'signal' | 'narrativeKey'>,
    trigger: NarrativeTrigger,
  ): Promise<void> {
    const policy = this.narrativePolicy;
    if (!this.options.narrative || !this.options.extractor || !shouldScanNarrative(policy, trigger))
      return;
    try {
      const messages = narrativeWindow(
        await this.options.narrative.recent(),
        policy.windowSize,
        policy.roles,
      );
      const key = stable(messages);
      if (
        !messages.length ||
        (trigger !== 'manual' && !policy.trigger.includes('decision') && key === this.narrativeKey)
      )
        return;
      const remaining = this.decisionEnd - this.now() - 15;
      if (remaining <= 0 || this.modelCalls >= this.policy.maxModelCallsPerDecision) return;
      this.modelCalls++;
      const extracted = await deadline(
        (s) => this.options.extractor!.extract(messages, c.observation, s),
        Math.min(remaining, this.policy.requestTimeoutMs),
        c.signal,
      );
      const context = validateNarrativeContext(extracted, c.observation);
      if (c.signal.aborted) return;
      c.goals = mergeGoals(c.goals, context.goals);
      c.observation.narrativeContext = context;
      c.narrativeKey = key;
    } catch {
      /* Missing or invalid narrative never blocks a host decision. */
    }
  }
  private async choose(
    request: DecisionRequest,
    signal: AbortSignal,
  ): Promise<Candidate | undefined> {
    request.recentActions = clone(this.memoryFor(request.commander.side).history);
    const candidates = request.candidates;
    const local = (this.options.selector ?? defaultSelector).select(candidates);
    if (
      !this.options.provider ||
      candidates.length < 2 ||
      this.now() < this.cooldownUntil ||
      this.modelCalls >= this.policy.maxModelCallsPerDecision ||
      (request.purpose === 'action' && this.policy.modelActionMode === 'local')
    ) {
      this.statusValue.provider = 'local';
      return local;
    }
    const remaining = this.decisionEnd - this.now() - 15;
    if (remaining <= 0) {
      this.stats.fallbacks++;
      return local;
    }
    try {
      this.modelCalls++;
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
      // Confidence continuously attenuates bounded model evidence; zero preserves local scores.
      const selected = (this.options.selector ?? defaultSelector).select(
        candidates.map((c) => ({
          ...c,
          total: c.total + clamp(answer.scores[c.id] ?? 0.5) * 3 * answer.confidence,
        })),
      );
      this.lastModelSelection = {
        model: answer.model,
        confidence: answer.confidence,
        purpose: request.purpose,
        stateVersion: request.stateVersion,
        localId: local?.id ?? '',
        selectedId: selected?.id ?? '',
      };
      return selected;
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
  private context(
    o: Observation,
    commander: Commander,
    goals: Goal[],
  ): import('./types.js').EvaluationContext & {
    capabilities: import('./execution-types.js').ResolvedCapabilities;
  } {
    return {
      ...evaluationContext(o, commander, this.profiles[commander.ability]!, goals),
      capabilities: this.capabilityResolver.resolve(o),
      memory: this.memoryFor(commander.side),
    };
  }
  private memoryFor(side: string): import('./types.js').TacticalMemory {
    if (!Object.hasOwn(this.memory, side))
      Object.defineProperty(this.memory, side, {
        value: { visited: [], history: [] },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return this.memory[side]!;
  }
  private compile(
    method: import('./types.js').TaskMethod,
    context: import('./types.js').EvaluationContext,
  ) {
    if (!method.decompose) return { network: undefined, modifiers: [] as string[] };
    const capabilities =
      context.capabilities ?? this.capabilityResolver.resolve(context.observation);
    const budget = 32 + context.profile.horizon * 32;
    let specs = method.decompose(context);
    let network = this.taskPlanner.plan(specs, context, capabilities, budget);
    if (!network) return undefined;
    const active: string[] = [],
      notes: string[] = [];
    for (const id of new Set([
      ...(method.modifiers ?? []),
      ...(context.commander.tactics?.modifiers ?? []),
    ])) {
      if (!this.modifiers.has(id)) {
        notes.push(id + '：模块未注册，已略过');
        continue;
      }
      const modifier = this.modifiers.get(id);
      if (
        !supports(capabilities, modifier.requirements) ||
        !(modifier.compatible?.(context) ?? true)
      ) {
        notes.push(modifier.label + '：当前机制或兵力不支持，已略过');
        continue;
      }
      const changed = modifier.apply(clone(specs), context);
      const result = this.taskPlanner.plan(changed, context, capabilities, budget);
      if (!result) {
        notes.push(modifier.label + '：无法构成可执行任务，已略过');
        continue;
      }
      specs = changed;
      network = result;
      active.push(id);
    }
    network.notes.push(...notes);
    return { network, modifiers: active };
  }
  private async planDecision(c: DecisionContext): Promise<void> {
    c.progress = advanceProgress(c.plan, c.progress, c.observation);
    const freshEvents = c.observation.events.filter((e) => !this.seenEvents.has(e.id));
    const replacements: Task[] = [],
      scope: string[] = [];
    for (const commander of c.commanders) {
      // Defer each side's first plan until that side can actually consult the provider.
      if (commander.side !== c.observation.activeSide) continue;
      const context = this.context(c.observation, commander, c.goals);
      const old = c.plan.tasks.find((t) => t.level === 'tactics' && t.commanderId === commander.id);
      const target = resolveTarget(context, old?.target);
      if (target) context.target = target;
      const changedTarget = targetIntent(context.target) !== targetIntent(old?.target);
      if (old && !changedTarget && target) old.target = target;
      const progress = old ? c.progress[old.id] : undefined;
      const strength = c.observation.units
        .filter((u) => commander.unitIds.includes(u.id))
        .reduce((s, u) => s + u.hp, 0);
      if (old && strength === 0) {
        if (progress) progress.status = 'completed';
        continue;
      }
      let failed = false;
      if (old?.network && progress) {
        const before = progress.execution?.revision ?? 0;
        this.taskExecutor.update(
          old,
          progress,
          context,
          freshEvents.map((e) => e.id),
        );
        failed = Object.values(progress.execution?.steps ?? {}).some((p) => p.status === 'failed');
        if ((progress.execution?.revision ?? 0) !== before) {
          const from = c.plan.version++;
          this.changes.push({
            from,
            to: c.plan.version,
            source: 'ai',
            reason: '修复受阻子任务，保留其他分支',
            events: freshEvents.map((e) => e.id),
            scope: [commander.id],
            cancelled: [],
            added: [],
          });
        }
      }
      const phase = old?.phases[progress?.phase ?? 0];
      const failure =
        failed ||
        !!(
          old &&
          !old.network &&
          phase &&
          progress &&
          strength < (old.strengthAtCreation ?? Infinity) * 0.75 &&
          conditionMet(phase.abort, c.observation, old, progress, context.goal)
        );
      const affected = freshEvents.some(
        (e) =>
          ['loss', 'goal', ...(!old?.network ? ['blocked'] : [])].includes(e.kind) &&
          (!e.unitIds?.length || e.unitIds.some((id) => commander.unitIds.includes(id))),
      );
      const configurationKey = stable({
        unitIds: commander.unitIds,
        ability: commander.ability,
        style: commander.style,
        profile: context.profile,
        tactics: commander.tactics ?? {},
      });
      const capabilityKey = stable(context.capabilities);
      const goalKey = stable(c.goals.filter((g) => g.side === commander.side));
      const changedGoals = goalKey !== old?.goalKey;
      const migrate = !!old && !old.network && !!this.doctrines.get(old.doctrineId).decompose;
      if (
        old?.locked ||
        (old &&
          !changedGoals &&
          !changedTarget &&
          !affected &&
          !failure &&
          !migrate &&
          old.configurationKey === configurationKey &&
          old.capabilityKey === capabilityKey)
      )
        continue;
      const failedDoctrines =
        changedGoals ||
        changedTarget ||
        old?.configurationKey !== configurationKey ||
        old?.capabilityKey !== capabilityKey
          ? []
          : [...(old?.failedDoctrines ?? []), ...(failed && old ? [old.doctrineId] : [])];
      const compiled = new Map<string, { network: TaskNetwork | undefined; modifiers: string[] }>();
      let methods = this.doctrines
        .all()
        .filter(
          (m) =>
            !failedDoctrines.includes(m.id) &&
            supports(context.capabilities, m.requirements) &&
            m.applicable(context),
        );
      methods = methods.filter((m) => {
        const result = this.compile(m, context);
        if (!result) return false;
        compiled.set(m.id, result);
        return true;
      });
      if (!methods.length) {
        // Legacy/basic hosts can always use their remaining legal commands, without inventing mechanics.
        const fallback = this.doctrines.get('hold-position');
        methods = [fallback];
        compiled.set(fallback.id, { network: undefined, modifiers: [] });
      }
      const methodCandidates: Candidate[] = methods
        .map((m) => {
          const preference = commander.tactics?.doctrineId === m.id ? 100 : 0;
          const utility =
            m.score(context) +
            preference +
            (context.goal.kind === 'withdraw' && m.family !== 'withdraw'
              ? -8
              : context.goal.kind === 'defend' && m.family === 'attack'
                ? -2
                : 0);
          const style = this.styles.score(m.features, commander.style);
          return {
            id: m.id,
            label: m.label,
            commanderId: commander.id,
            goal: context.goal,
            features: m.features,
            utility,
            risk: 0,
            continuity: old?.doctrineId === m.id ? 0.3 : 0,
            style,
            total: utility + style,
            steps:
              compiled
                .get(m.id)
                ?.network?.steps.map(({ effects: _effects, ...step }) => clone(step)) ?? [],
            summary:
              compiled
                .get(m.id)
                ?.network?.steps.map(
                  (s) =>
                    (STEP_LABELS[s.task] ?? s.task) +
                    '[' +
                    s.unitIds.join(',') +
                    ']' +
                    (s.target ? ' @' + s.target : '') +
                    (s.targetUnitId ? ' →' + s.targetUnitId : ''),
                )
                .join(' → ') ?? m.label,
          };
        })
        .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
      const choices = methodCandidates.slice(0, context.profile.candidateLimit);
      // The catalogue hierarchy is local metadata; it does not add sequential model requests.
      const picked =
        commander.side === c.observation.activeSide
          ? await this.choose(
              {
                id: c.observation.version + ':' + commander.id + ':doctrine',
                sessionId: c.observation.sessionId,
                stateVersion: c.observation.version,
                planVersion: c.plan.version,
                purpose: 'doctrine',
                goal: context.goal,
                observation: c.observation,
                commander,
                candidates: choices,
              },
              c.signal,
            )
          : (this.options.selector ?? defaultSelector).select(choices);
      const method = this.doctrines.get(picked!.id),
        compiledPlan = compiled.get(method.id)!;
      const task = taskFromMethod(
        commander.id + '-v' + (c.plan.version + 1),
        commander,
        context.goal,
        c.plan.version + 1,
        method,
        context,
        methodCandidates
          .filter((m) => m.id !== method.id)
          .slice(0, context.profile.branches)
          .map((m) => m.id),
      );
      task.configurationKey = configurationKey;
      if (context.target) task.target = context.target;
      task.goalKey = goalKey;
      task.capabilityKey = capabilityKey;
      task.failedDoctrines = [...new Set(failedDoctrines)];
      task.parameters = { ...method.parameters, ...commander.tactics?.parameters };
      task.modifiers = compiledPlan.modifiers;
      if (compiledPlan.network) {
        task.network = compiledPlan.network;
        if (commander.tactics?.doctrineId && method.id !== commander.tactics.doctrineId)
          task.network.notes.push('指定战法当前不可行，自动选择：' + method.label);
        task.phases = task.network.steps.map((s) => ({
          id: s.id,
          title: STEP_LABELS[s.task] ?? s.task,
          intent: s.task,
          enter: { kind: 'always' },
          complete: { kind: 'at-target' },
          abort: { kind: 'low-strength', value: 0.2 },
          roles: ['assault', 'support', 'reserve'],
        }));
      }
      replacements.push(task);
      scope.push(commander.id);
      this.stats.maxHorizon = Math.max(this.stats.maxHorizon, context.profile.horizon);
      this.stats.lastBranches = task.alternatives.length;
    }
    if (replacements.length) {
      const result = applyPlanPatch(
        c.plan,
        c.progress,
        {
          baseVersion: c.plan.version,
          source: 'ai',
          reason: c.plan.version === 0 ? '生成可执行任务计划' : '按当前条件修订受影响任务',
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
    for (const commander of c.commanders) {
      const goal = goalFor(commander, c.goals);
      const parent = (id: string, level: Task['level'], parentId?: string): Task => ({
        id,
        side: commander.side,
        level,
        commanderId: commander.id,
        goalId: goal.id,
        doctrineId: 'hold-position',
        family: 'command',
        unitIds: [],
        planVersion: c.plan.version,
        phases: [],
        alternatives: [],
        locked: false,
        resourceCommitment: 0,
        ...(parentId ? { parentId } : {}),
      });
      const root = 'strategy-' + commander.side;
      if (!c.plan.tasks.some((t) => t.id === root)) c.plan.tasks.unshift(parent(root, 'strategy'));
      const campaign = 'campaign-' + commander.id;
      if (!c.plan.tasks.some((t) => t.id === campaign))
        c.plan.tasks.push(
          parent(
            campaign,
            'campaign',
            commander.parentId ? 'campaign-' + commander.parentId : root,
          ),
        );
      const task = c.plan.tasks.find(
        (t) => t.level === 'tactics' && t.commanderId === commander.id,
      );
      if (task?.network)
        this.taskExecutor.update(
          task,
          c.progress[task.id]!,
          this.context(c.observation, commander, c.goals),
          [],
        );
    }
  }
  private async makeCandidates(c: DecisionContext): Promise<void> {
    const authorized = c.commanders
      .filter((cmd) => cmd.side === c.observation.activeSide)
      .flatMap((cmd) => cmd.unitIds);
    const raw = await this.options.adapter.legalActions(c.observation, authorized);
    const rejected = new Set(
      this.receipts
        .filter((r) => !r.applied && r.stateVersion === c.observation.version)
        .map((r) => r.actionId),
    );
    const legal = (this.options.coordinator ?? defaultCoordinator)
      .filter(raw, c)
      .filter((a) => !rejected.has(a.id));
    const awaiting = new Set(
      Object.values(c.progress).flatMap((p) =>
        Object.values(p.execution?.steps ?? {}).flatMap((s) => s.awaiting.map((a) => a.unitId)),
      ),
    );
    this.activeOrders.forEach((a) => awaiting.add(a.unitId));
    const leases = new Map<string, string>();
    for (const task of c.plan.tasks.filter((t) => t.side === c.observation.activeSide)) {
      for (const step of task.network?.steps ?? []) {
        if (c.progress[task.id]?.execution?.steps[step.id]?.status !== 'running') continue;
        const owner = task.id + '/' + step.id;
        const claims = [...step.unitIds.map((id) => 'unit:' + id), ...(step.resources ?? [])];
        if (claims.some((key) => leases.has(key))) continue;
        claims.forEach((key) => leases.set(key, owner));
      }
    }
    c.candidates = [];
    for (const commander of c.commanders.filter((cmd) => cmd.side === c.observation.activeSide)) {
      const context = this.context(c.observation, commander, c.goals);
      const task = c.plan.tasks.find(
        (t) => t.level === 'tactics' && t.commanderId === commander.id,
      );
      if (!task) continue;
      context.task = task;
      const method = this.doctrines.get(task.doctrineId),
        progress = c.progress[task.id]!;
      const scored: Candidate[] = [];
      for (const action of legal.filter(
        (a) => task.unitIds.includes(a.unitId) && !awaiting.has(a.unitId),
      )) {
        const assignment = c.assignments.find((a) => a.unitId === action.unitId);
        const candidate = {
          ...scoreAction(
            action,
            { ...context, ...(assignment ? { assignment } : {}) },
            method,
            this.styles,
            this.options.evaluators ?? [defaultEvaluator],
          ),
          commanderId: commander.id,
          goal: context.goal,
        };
        if (!task.network) {
          scored.push(candidate);
          continue;
        }
        const options = this.taskExecutor
          .options(action, task, progress, context)
          .filter((option) => {
            if (!Number.isFinite(option.score)) return false;
            if (option.stepId === undefined) {
              const owner = leases.get('unit:' + action.unitId);
              return (
                !owner || task.network!.steps.some((step) => owner === task.id + '/' + step.id)
              );
            }
            const step = task.network!.steps.find((s) => s.id === option.stepId);
            if (!step) return false;
            return ['unit:' + action.unitId, ...(step.resources ?? [])].every(
              (key) => leases.get(key) === task.id + '/' + step.id,
            );
          })
          .sort((a, b) => b.score - a.score);
        const selected = options[0];
        if (selected)
          scored.push({
            ...candidate,
            taskId: task.id,
            ...(selected.stepId !== undefined ? { stepId: selected.stepId } : {}),
            utility: candidate.utility + selected.score,
            total: candidate.total + selected.score,
          });
        else if (
          isAction(context.capabilities, 'wait', action.kind) ||
          isAction(context.capabilities, 'defend', action.kind)
        ) {
          // A blocked branch may yield its action opportunity, but may not attack ahead of its dependencies.
          scored.push({ ...candidate, taskId: task.id, total: -100, utility: -100 });
        }
      }
      scored.sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
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
