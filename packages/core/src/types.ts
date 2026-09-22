import type {
  HostCapabilities,
  ResolvedCapabilities,
  TaskNetwork,
  ExecutionProgress,
  TaskSpec,
  TacticalPreferences,
} from './execution-types.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Ability = 'novice' | 'regular' | 'skilled' | 'expert' | 'master' | (string & {});
export type Side = string;
export type Style = Record<string, number>;
export interface Commander {
  id: string;
  name: string;
  side: Side;
  parentId?: string;
  unitIds: string[];
  ability: Ability;
  style: Style;
  tactics?: TacticalPreferences;
}
export interface Unit {
  id: string;
  name: string;
  side: Side;
  location: string;
  hp: number;
  maxHp: number;
  attack: number;
  range: number;
  ap: number;
  ammo: number;
  tags: string[];
  speed?: number;
  attackInterval?: number;
}
export interface Location {
  id: string;
  label: string;
  x: number;
  y: number;
  cover: number;
  blocked: boolean;
  neighbors: string[];
}
export interface BattleMap {
  kind: string;
  locations: Location[];
}
export interface Observation {
  /** Narrative hints only; never authoritative battle facts. */
  narrativeContext?: NarrativeContext;
  sessionId: string;
  version: number;
  turn: number;
  activeSide: Side;
  units: Unit[];
  map: BattleMap;
  goals: Goal[];
  events: HostEvent[];
  ended: boolean;
  winner?: Side;
  capabilities?: HostCapabilities;
  /** Durable order keys. Required only for commands acknowledged before completion. */
  orders?: Record<string, 'running' | 'succeeded' | 'failed'>;
}
export interface HostEvent {
  id: string;
  kind: 'start' | 'turn' | 'loss' | 'blocked' | 'goal' | 'manual' | 'observation' | (string & {});
  unitIds?: string[];
  location?: string;
}
export interface Goal {
  id: string;
  title: string;
  kind: 'eliminate' | 'capture' | 'defend' | 'withdraw' | 'recon' | (string & {});
  priority: number;
  source: 'user' | 'host' | 'narrative' | 'default';
  version: number;
  side: Side;
  target?: string;
  constraints?: string[];
}
export interface Features {
  [key: string]: number;
}
export interface BattleAction {
  id: string;
  unitId: string;
  kind: string;
  targetId?: string;
  destination?: string;
  cost: number;
  features: Features;
}
export interface ActionEnvelope {
  turn?: number;
  sessionId: string;
  stateVersion: number;
  planVersion: number;
  key: string;
  action: BattleAction;
  taskId?: string;
  stepId?: string;
}
export interface ActionReceipt {
  key: string;
  actionId: string;
  stateVersion: number;
  applied: boolean;
  detail: string;
  execution?: 'running' | 'succeeded' | 'failed';
}
/** Host must atomically recheck state and deduplicate durable keys with the action. */
export interface BattleAdapter {
  readonly id: string;
  observe(): Promise<Observation>;
  legalActions(observation: Observation, unitIds: readonly string[]): Promise<BattleAction[]>;
  execute(envelope: ActionEnvelope): Promise<ActionReceipt>;
  receipt(key: string): Promise<ActionReceipt | null>;
  snapshot(): Promise<Json>;
  restore?(snapshot: Json): Promise<void>;
}
export interface CapabilityProfile {
  id: string;
  label: string;
  candidateLimit: number;
  horizon: number;
  factors: string[];
  coordination: number;
  branches: number;
  enemyResponses: number;
}
export interface Condition {
  kind:
    'always' | 'turns' | 'enemy-near' | 'low-strength' | 'at-target' | 'no-enemy' | 'support-ready';
  value?: number;
}
export interface Phase {
  id: string;
  title: string;
  intent: string;
  enter: Condition;
  complete: Condition;
  abort: Condition;
  roles: string[];
}
export interface Task {
  id: string;
  side: Side;
  parentId?: string;
  level: 'strategy' | 'campaign' | 'tactics';
  commanderId: string;
  goalId: string;
  doctrineId: string;
  family: string;
  unitIds: string[];
  planVersion: number;
  phases: Phase[];
  alternatives: string[];
  region?: string;
  locked: boolean;
  resourceCommitment: number;
  strengthAtCreation?: number;
  configurationKey?: string;
  goalKey?: string;
  network?: TaskNetwork;
  parameters?: Record<string, Json>;
  modifiers?: string[];
  capabilityKey?: string;
  failedDoctrines?: string[];
  /** Fixed objectives, observed contacts and exploratory waypoints have different lifetimes. */
  target?: TacticalTarget;
}
export interface TaskProgress {
  taskId: string;
  status: 'active' | 'completed' | 'cancelled';
  phase: number;
  enteredTurn: number;
  actions: number;
  execution?: ExecutionProgress;
}
export interface BattlePlan {
  id: string;
  version: number;
  goals: Goal[];
  tasks: Task[];
  createdTurn: number;
}
export interface PlanPatch {
  baseVersion: number;
  source: 'user' | 'host' | 'ai' | 'restore';
  reason: string;
  events: string[];
  scope: string[];
  replaceTasks?: Task[];
  lock?: { taskId: string; locked: boolean };
}
export interface Revision {
  from: number;
  to: number;
  source: PlanPatch['source'];
  reason: string;
  events: string[];
  scope: string[];
  cancelled: string[];
  added: string[];
}
export interface RoleAssignment {
  unitId: string;
  taskId: string;
  role: string;
  committed: boolean;
}
export interface Assessment {
  friendlyStrength: number;
  enemyStrength: number;
  advantage: number;
  threat: number;
  uncertainty: number;
  blocked: string[];
}
export interface Candidate {
  id: string;
  label: string;
  features: Features;
  utility: number;
  risk: number;
  continuity: number;
  style: number;
  total: number;
  action?: BattleAction;
  taskId?: string;
  stepId?: string;
  summary?: string;
  commanderId?: string;
  goal?: Goal;
  /** Executable proposal, rather than only a tactic name or prose summary. */
  steps?: TaskSpec[];
}
export interface TacticalTarget {
  kind: 'fixed' | 'contact' | 'search';
  location: string;
  unitId?: string;
}
export interface RecentAction {
  key: string;
  turn: number;
  action: BattleAction;
  outcome: 'succeeded' | 'running' | 'failed' | 'rejected';
}
export interface TacticalMemory {
  /** Bounded, oldest-first list of locations actually visited by this side. */
  visited: string[];
  history: RecentAction[];
}
export interface DecisionRequest {
  id: string;
  sessionId: string;
  stateVersion: number;
  planVersion: number;
  purpose: 'family' | 'doctrine' | 'action';
  goal?: Goal;
  observation: Observation;
  commander: Commander;
  candidates: Candidate[];
  recentActions?: RecentAction[];
}
export interface DecisionAnswer {
  scores: Record<string, number>;
  confidence: number;
  model: string;
}
export interface DecisionProvider {
  readonly id: string;
  evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionAnswer>;
}
export interface ModelRecord {
  request: DecisionRequest;
  answer?: DecisionAnswer;
  error?: string;
}
export interface ModelSelection {
  model: string;
  confidence: number;
  purpose: DecisionRequest['purpose'];
  stateVersion: number;
  localId: string;
  selectedId: string;
}
export interface EvaluationContext {
  observation: Observation;
  commander: Commander;
  profile: CapabilityProfile;
  goal: Goal;
  task?: Task;
  assignment?: RoleAssignment;
  assessment: Assessment;
  capabilities?: ResolvedCapabilities;
  target?: TacticalTarget;
  memory?: TacticalMemory;
}
export interface Evaluator {
  id: string;
  evaluate(
    action: BattleAction,
    context: EvaluationContext,
  ): { utility: number; risk: number; continuity: number };
}
export interface Selector {
  select(candidates: Candidate[]): Candidate | undefined;
}
export interface StyleDimension {
  id: string;
  label: string;
  low: string;
  high: string;
  effect: string;
  contribution(features: Features, value: number): number;
}
export interface TaskMethod {
  id: string;
  version: string;
  label: string;
  family: 'attack' | 'defend' | 'withdraw' | string;
  features: Features;
  applicable(context: EvaluationContext): boolean;
  score(context: EvaluationContext): number;
  phases(context: EvaluationContext): Phase[];
  actionBias(action: BattleAction, context: EvaluationContext): number;
  categoryId?: string;
  requirements?: string[];
  modifiers?: string[];
  parameters?: Record<string, Json>;
  decompose?(context: EvaluationContext): TaskSpec[];
}
export interface Allocator {
  allocate(
    observation: Observation,
    commanders: Commander[],
    plan: BattlePlan,
    progress: Record<string, TaskProgress>,
    profiles: Record<string, CapabilityProfile>,
  ): RoleAssignment[];
}
export interface Coordinator {
  filter(actions: BattleAction[], context: DecisionContext): BattleAction[];
}
export interface GoalSource {
  read(observation: Observation): Promise<Goal[]>;
}
export interface NarrativeMessage {
  id: string;
  role: string;
  text: string;
  completed: boolean;
}
export interface NarrativeSource {
  recent(): Promise<NarrativeMessage[]>;
}
export interface TextExtractor {
  extract(
    messages: NarrativeMessage[],
    observation: Observation,
    signal: AbortSignal,
  ): Promise<Goal[] | NarrativeContext>;
}
export type NarrativeTrigger = 'battle-start' | 'message-change' | 'decision' | 'manual';
export interface NarrativeContextPolicy {
  windowSize: number;
  roles: string[];
  trigger: NarrativeTrigger[];
  mode: 'auto' | 'manual' | 'off';
}
export interface NarrativeContext {
  goals: Goal[];
  battleType?: string;
  environment?: string[];
  summary?: string;
}
export interface RuntimePolicy {
  narrativeContext?: NarrativeContextPolicy;
  mode: 'silent-auto';
  requestTimeoutMs: number;
  decisionBudgetMs: number;
  failureThreshold: number;
  cooldownMs: number;
  retries: number;
  retryDelayMs: number;
  tickDelayMs: number;
  narrativeWindow: number;
  narrativeRoles: string[];
  narrativeMode: 'auto' | 'manual' | 'off';
  maxModelCallsPerDecision: number;
  modelActionMode: 'local' | 'model';
}
export interface Status {
  state: 'idle' | 'running' | 'paused' | 'waiting' | 'degraded' | 'stopped' | 'ended';
  detail: string;
  savedRevision: number;
  provider: string;
  confirmations: 0;
}
export interface Metrics {
  decisions: number;
  actions: number;
  fallbacks: number;
  stale: number;
  approvals: 0;
  evaluations: number;
  stages: Record<string, number>;
  lastFactors: string[];
  lastCandidates: number;
  maxHorizon: number;
  lastCoordination: number;
  lastBranches: number;
}
export interface Checkpoint {
  formatVersion: 1;
  sessionId: string;
  revision: number;
  plan: BattlePlan;
  progress: Record<string, TaskProgress>;
  commanders: Commander[];
  goals: Goal[];
  revisions: Revision[];
  records: ModelRecord[];
  receipts: ActionReceipt[];
  pending: ActionEnvelope | null;
  host: Json;
  metrics: Metrics;
  seenEvents: string[];
  paused: boolean;
  narrativeKey?: string;
  narrativeContext?: NarrativeContext;
  activeOrders?: { key: string; unitId: string }[];
  memory?: Record<Side, TacticalMemory>;
  lastModelSelection?: ModelSelection;
}
export interface PlanStore {
  load(sessionId: string): Promise<Checkpoint | null>;
  save(checkpoint: Checkpoint, expectedRevision: number): Promise<void>;
}
export interface DecisionContext {
  narrativeKey?: string;
  observation: Observation;
  commanders: Commander[];
  goals: Goal[];
  plan: BattlePlan;
  progress: Record<string, TaskProgress>;
  assignments: RoleAssignment[];
  assessment: Assessment;
  candidates: Candidate[];
  selected?: Candidate;
  signal: AbortSignal;
  trace: string[];
}
export interface StageMetadata {
  id: string;
  version: string;
  dependencies: string[];
  inputs: string[];
  outputs: string[];
  capabilities: string[];
  budgetMs: number;
  config: Record<string, Json>;
}
export interface DecisionStage extends StageMetadata {
  enabled?(context: DecisionContext): boolean;
  run(context: DecisionContext): Promise<void>;
}
export interface WorkflowProfile {
  id: string;
  stages: string[];
  capabilities: string[];
}
