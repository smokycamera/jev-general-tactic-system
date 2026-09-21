import type {
  ActionEnvelope,
  ActionReceipt,
  BattleAction,
  EvaluationContext,
  Observation,
  Task,
  TaskProgress,
} from './types.js';
import type {
  ExecutionContext,
  ExecutionPolicy,
  ExecutionProgress,
  PlannedStep,
  StepProgress,
  TaskExecutor,
  TaskOperator,
} from './execution-types.js';
import { Registry } from './registry.js';
import { supports } from './capabilities.js';
import { capabilitiesFor, taskUnits } from './operators.js';
import { orderedTasks } from './htn.js';
import { clone, stable } from './util.js';

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = { maxIdleTurns: 3, maxRepairs: 2 };
export const STEP_LABELS: Record<string, string> = {
  move: '接近与机动',
  rally: '集结',
  engage: '交战',
  fire: '火力准备',
  fix: '牵制',
  hold: '保持阵地',
  withdraw: '撤退',
  recon: '侦察',
  smoke: '施放烟幕',
  suppress: '压制',
  conceal: '隐蔽',
  cover: '掩护就绪',
  contact: '等待接触',
  delay: '迟滞',
  probe: '试探',
  commit: '预备队投入',
};
export function executionProgress(): ExecutionProgress {
  return {
    steps: {},
    facts: {},
    state: '准备',
    repairs: 0,
    revision: 0,
    events: [],
    repairLog: [],
  };
}
function freshStep(turn: number): StepProgress {
  return {
    status: 'pending',
    enteredTurn: turn,
    lastProgressTurn: turn,
    signature: '',
    attempts: 0,
    actions: {},
    awaiting: [],
  };
}
export function syncExecutionOrders(progress: TaskProgress, observation: Observation): void {
  for (const p of Object.values(progress.execution?.steps ?? {})) {
    p.awaiting = p.awaiting.filter((pending) => {
      const status = observation.orders?.[pending.key];
      if (!status || status === 'running') return true;
      if (status === 'failed') {
        p.status = 'failed';
        p.reason = '宿主报告执行失败';
      } else p.actions[pending.kind] = (p.actions[pending.kind] ?? 0) + 1;
      p.lastProgressTurn = observation.turn;
      return false;
    });
  }
}
/** Called only once per durable receipt, including crash recovery. */
export function recordExecution(
  progress: TaskProgress,
  envelope: ActionEnvelope,
  receipt: ActionReceipt,
  context: EvaluationContext,
): void {
  const p = envelope.stepId ? progress.execution?.steps[envelope.stepId] : undefined;
  if (!p) return;
  if (!receipt.applied) {
    p.status = 'failed';
    p.reason = '宿主拒绝动作：' + receipt.detail;
    return;
  }
  const capabilities = capabilitiesFor(context);
  const semantic =
    Object.entries(capabilities.actionKinds).find(([, kinds]) =>
      kinds.includes(envelope.action.kind),
    )?.[0] ?? envelope.action.kind;
  if (receipt.execution === 'running')
    p.awaiting.push({ key: receipt.key, kind: semantic, unitId: envelope.action.unitId });
  else if (receipt.execution === 'failed') {
    p.status = 'failed';
    p.reason = '宿主报告执行失败';
  } else p.actions[semantic] = (p.actions[semantic] ?? 0) + 1;
}
export class NetworkExecutor implements TaskExecutor {
  readonly policy: ExecutionPolicy;
  constructor(
    readonly operators: Registry<TaskOperator>,
    policy: Partial<ExecutionPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_EXECUTION_POLICY, ...policy };
    if (
      !Number.isInteger(this.policy.maxIdleTurns) ||
      this.policy.maxIdleTurns < 1 ||
      !Number.isInteger(this.policy.maxRepairs) ||
      this.policy.maxRepairs < 0
    )
      throw new Error('invalid execution policy');
  }
  private context(
    task: Task,
    taskProgress: TaskProgress,
    step: PlannedStep,
    evaluation: EvaluationContext,
  ): ExecutionContext {
    const execution = taskProgress.execution!;
    // Manual intervention may remove a unit from this task while retaining its old history.
    const spec = { ...step, unitIds: step.unitIds.filter((id) => task.unitIds.includes(id)) };
    return {
      task,
      taskProgress,
      step,
      spec,
      progress: execution.steps[step.id]!,
      evaluation,
      capabilities: capabilitiesFor(evaluation),
      facts: execution.facts,
    };
  }
  update(
    task: Task,
    progress: TaskProgress,
    evaluation: EvaluationContext,
    events: string[],
  ): void {
    if (!task.network) return;
    const e = (progress.execution ??= executionProgress()),
      o = evaluation.observation;
    syncExecutionOrders(progress, o);
    for (const step of orderedTasks(task.network.steps)) {
      const p = (e.steps[step.id] ??= freshStep(o.turn));
      if (p.status === 'succeeded' || p.status === 'skipped') continue;
      if (
        !step.after.every((id) =>
          ['succeeded', 'skipped'].includes(e.steps[id]?.status ?? 'pending'),
        )
      )
        continue;
      if (!this.operators.has(step.task)) {
        p.status = 'failed';
        p.reason = '操作模块未注册：' + step.task;
        continue;
      }
      const op = this.operators.get(step.task);
      if (p.status === 'pending') {
        p.status = 'running';
        p.enteredTurn = o.turn;
        p.lastProgressTurn = o.turn;
      }
      const c = this.context(task, progress, step, evaluation);
      if (p.awaiting.length) continue;
      const support = step.data?.requiredSupport;
      const supportAlive =
        !Array.isArray(support) ||
        support.some((id) => o.units.some((u) => u.id === id && u.hp > 0));
      const outcome =
        p.status !== 'failed' &&
        supportAlive &&
        supports(c.capabilities, op.requirements) &&
        (op.canExecute?.(c) ?? true)
          ? op.observe(c)
          : 'failed';
      if (outcome === 'succeeded') {
        p.status = 'succeeded';
        Object.assign(e.facts, clone(step.effects));
        continue;
      }
      const signature =
        op.signature?.(c) ?? stable(taskUnits(c).map((u) => [u.id, u.location, u.hp]));
      if (signature !== p.signature) {
        p.signature = signature;
        p.lastProgressTurn = o.turn;
      }
      const targetBlocked =
        !!step.target && o.map.locations.some((l) => l.id === step.target && l.blocked);
      const stalled =
        op.watchdog !== false && o.turn - p.lastProgressTurn >= this.policy.maxIdleTurns;
      if (outcome === 'failed' || p.status === 'failed' || targetBlocked || stalled) {
        const replacement = p.attempts < this.policy.maxRepairs ? op.repair?.(c) : undefined;
        if (
          replacement &&
          supports(c.capabilities, op.requirements) &&
          (op.canPlan?.({ ...c, spec: replacement }) ?? true)
        ) {
          // Retain IDs/dependencies and all other branches. Repairs may change arguments, not command ownership.
          if (
            replacement.task !== step.task ||
            replacement.unitIds.some((id) => !task.unitIds.includes(id))
          )
            throw new Error('invalid task repair');
          Object.assign(step, {
            ...replacement,
            id: step.id,
            after: step.after,
            effects: clone(op.predict?.({ ...c, spec: replacement }) ?? {}),
          });
          p.attempts++;
          p.status = 'running';
          p.lastProgressTurn = o.turn;
          p.signature = '';
          e.repairs++;
          e.revision++;
          e.repairLog.push(step.id + '：重新选择可达位置');
        } else {
          p.status = step.optional ? 'skipped' : 'failed';
          p.reason = targetBlocked ? '通路阻塞' : stalled ? '任务无进展' : '执行条件失效';
        }
      }
    }
    e.events = [...new Set([...e.events, ...events])];
    const running = task.network.steps.filter((s) => e.steps[s.id]?.status === 'running');
    const failed = Object.values(e.steps).some((p) => p.status === 'failed');
    e.state = failed
      ? '需要改案'
      : running.map((s) => STEP_LABELS[s.task] ?? s.task).join(' / ') || '任务完成';
    const allDone = task.network.steps.every((s) =>
      ['succeeded', 'skipped'].includes(e.steps[s.id]?.status ?? 'pending'),
    );
    if (allDone) progress.status = 'completed';
    progress.phase = Math.max(
      0,
      task.network.steps.findIndex(
        (s) => !['succeeded', 'skipped'].includes(e.steps[s.id]?.status ?? 'pending'),
      ),
    );
  }
  options(
    action: BattleAction,
    task: Task,
    progress: TaskProgress,
    evaluation: EvaluationContext,
  ): { stepId: string; score: number }[] {
    if (!task.network || !progress.execution || progress.status !== 'active') return [];
    const result = [];
    for (const step of task.network.steps) {
      const p = progress.execution.steps[step.id];
      if (
        p?.status !== 'running' ||
        p.awaiting.some((a) => a.unitId === action.unitId) ||
        !step.unitIds.includes(action.unitId) ||
        !this.operators.has(step.task)
      )
        continue;
      const c = this.context(task, progress, step, evaluation);
      if (!supports(c.capabilities, this.operators.get(step.task).requirements)) continue;
      const value = this.operators.get(step.task).score(action, c);
      if (value !== undefined && Number.isFinite(value))
        result.push({ stepId: step.id, score: value });
    }
    return result;
  }
}
