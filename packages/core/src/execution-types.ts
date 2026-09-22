import type {
  BattleAction,
  EvaluationContext,
  Json,
  Observation,
  Task,
  TaskProgress,
} from './types.js';

export interface HostCapabilities {
  /** Arbitrary registered mechanism IDs. Explicit false overrides conservative inference. */
  mechanisms?: Record<string, boolean>;
  /** Semantic action name -> host action kinds. No new host action is fabricated. */
  actionKinds?: Record<string, string[]>;
  fullyObservable?: boolean;
}
export interface ResolvedCapabilities {
  mechanisms: Record<string, boolean>;
  actionKinds: Record<string, string[]>;
  fullyObservable: boolean;
}
export interface CapabilityResolver {
  resolve(observation: Observation): ResolvedCapabilities;
}
export interface TacticalPreferences {
  doctrineId?: string;
  modifiers?: string[];
  parameters?: Record<string, Json>;
}
export interface TacticCategory {
  id: string;
  label: string;
  parentId?: string;
}
export type PlanningFacts = Record<string, Json>;
export interface TaskSpec {
  id: string;
  task: string;
  unitIds: string[];
  after: string[];
  target?: string;
  data?: Record<string, Json>;
  optional?: boolean;
  resources?: string[];
}
export interface PlannedStep extends TaskSpec {
  effects: PlanningFacts;
}
export interface TaskNetwork {
  steps: PlannedStep[];
  methods: string[];
  notes: string[];
  expanded: number;
}
export interface PlanningContext {
  evaluation: EvaluationContext;
  capabilities: ResolvedCapabilities;
  facts: PlanningFacts;
  spec: TaskSpec;
}
export interface HtnMethod {
  id: string;
  task: string;
  requirements?: string[];
  applicable?(context: PlanningContext): boolean;
  expand(context: PlanningContext): TaskSpec[];
}
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export interface StepProgress {
  status: StepStatus;
  enteredTurn: number;
  lastProgressTurn: number;
  signature: string;
  attempts: number;
  actions: Record<string, number>;
  awaiting: { key: string; kind: string; unitId: string }[];
  reason?: string;
}
export interface ExecutionProgress {
  steps: Record<string, StepProgress>;
  facts: PlanningFacts;
  state: string;
  repairs: number;
  revision: number;
  events: string[];
  repairLog: string[];
}
export interface ExecutionContext extends PlanningContext {
  task: Task;
  taskProgress: TaskProgress;
  step: PlannedStep;
  progress: StepProgress;
}
export interface TaskOperator {
  id: string;
  requirements?: string[];
  canPlan?(context: PlanningContext): boolean;
  canExecute?(context: ExecutionContext): boolean;
  predict?(context: PlanningContext): PlanningFacts;
  observe(context: ExecutionContext): 'running' | 'succeeded' | 'failed';
  /** undefined excludes an action; the number is a local execution preference. */
  score(action: BattleAction, context: ExecutionContext): number | undefined;
  signature?(context: ExecutionContext): string;
  repair?(context: ExecutionContext): TaskSpec | undefined;
  watchdog?: boolean;
}
export interface TacticalModifier {
  id: string;
  label: string;
  requirements?: string[];
  compatible?(context: EvaluationContext): boolean;
  apply(tasks: TaskSpec[], context: EvaluationContext): TaskSpec[];
}
export interface TaskPlanner {
  plan(
    tasks: TaskSpec[],
    context: EvaluationContext,
    capabilities: ResolvedCapabilities,
    budget: number,
  ): TaskNetwork | undefined;
}
export interface TaskExecutor {
  update(task: Task, progress: TaskProgress, context: EvaluationContext, events: string[]): void;
  options(
    action: BattleAction,
    task: Task,
    progress: TaskProgress,
    context: EvaluationContext,
    /** Omit stepId for a host-defined reactive action that does not advance a plan step.
     * Authorization, in-flight orders and unit leases are still checked by the runtime. */
  ): { stepId?: string; score: number }[];
}
export interface ExecutionPolicy {
  maxIdleTurns: number;
  maxRepairs: number;
}
