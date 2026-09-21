import type { EvaluationContext } from './types.js';
import type {
  HtnMethod,
  PlannedStep,
  PlanningContext,
  PlanningFacts,
  ResolvedCapabilities,
  TaskNetwork,
  TaskOperator,
  TaskPlanner,
  TaskSpec,
} from './execution-types.js';
import { Registry } from './registry.js';
import { supports } from './capabilities.js';
import { assert, clone } from './util.js';

/** Dependencies express execution order, independently of command hierarchy. */
export function orderedTasks<T extends { id: string; after: string[] }>(tasks: T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  assert(byId.size === tasks.length, 'duplicate network task');
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    result: T[] = [];
  const visit = (id: string) => {
    assert(!visiting.has(id), 'task dependency cycle: ' + id);
    if (visited.has(id)) return;
    const task = byId.get(id);
    assert(task, 'missing task dependency: ' + id);
    visiting.add(id);
    task.after.forEach(visit);
    visiting.delete(id);
    visited.add(id);
    result.push(task);
  };
  tasks.forEach((t) => visit(t.id));
  return result;
}

/** Only completed predecessors' predicted effects are visible, never unrelated parallel branches. */
function projectedFacts(steps: PlannedStep[], dependencies: string[]): PlanningFacts {
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    steps.find((s) => s.id === id)?.after.forEach(visit);
  };
  dependencies.forEach(visit);
  return Object.assign({}, ...steps.filter((s) => ancestors.has(s.id)).map((s) => s.effects));
}

/** Bounded forward decomposition with backtracking; prediction never mutates Observation. */
export class HtnPlanner implements TaskPlanner {
  constructor(
    readonly operators: Registry<TaskOperator>,
    readonly methods: Registry<HtnMethod>,
  ) {}
  plan(
    tasks: TaskSpec[],
    evaluation: EvaluationContext,
    capabilities: ResolvedCapabilities,
    budget: number,
  ): TaskNetwork | undefined {
    let expanded = 0;
    const operators = this.operators,
      methods = this.methods;
    type Draft = Pick<TaskNetwork, 'steps' | 'methods' | 'notes'>;
    function* expand(
      specs: TaskSpec[],
      prefix: string,
      predecessors: string[],
      initial: Draft,
      depth: number,
    ): Generator<Draft> {
      if (depth > 32) return;
      const ordered = orderedTasks(specs);
      function* walk(
        index: number,
        draft: Draft,
        endpoints: Record<string, string[]>,
      ): Generator<Draft> {
        const spec = ordered[index];
        if (!spec) {
          yield draft;
          return;
        }
        if (++expanded > budget) return;
        const after = [
          ...new Set([...predecessors, ...spec.after.flatMap((id) => endpoints[id] ?? [])]),
        ];
        const id = prefix + spec.id;
        const context: PlanningContext = {
          evaluation,
          capabilities,
          spec: { ...clone(spec), id, after },
          facts: projectedFacts(draft.steps, after),
        };
        const next = function* (value: Draft, ends: string[]): Generator<Draft> {
          yield* walk(index + 1, value, { ...endpoints, [spec.id]: ends });
        };
        let yielded = false;
        if (operators.has(spec.task)) {
          const op = operators.get(spec.task);
          if (supports(capabilities, op.requirements) && (op.canPlan?.(context) ?? true)) {
            const step: PlannedStep = {
              ...clone(spec),
              id,
              after,
              effects: clone(op.predict?.(context) ?? {}),
            };
            for (const result of next({ ...draft, steps: [...draft.steps, step] }, [id])) {
              yielded = true;
              yield result;
            }
          }
        } else {
          for (const method of methods.all().filter((m) => m.task === spec.task)) {
            if (++expanded > budget) return;
            if (
              !supports(capabilities, method.requirements) ||
              !(method.applicable?.(context) ?? true)
            )
              continue;
            const children = method.expand(context);
            const branch = { ...draft, methods: [...draft.methods, method.id] };
            for (const value of expand(children, id + '/', after, branch, depth + 1)) {
              const added = value.steps.slice(draft.steps.length);
              const parents = new Set(added.flatMap((s) => s.after));
              const ends = added.filter((s) => !parents.has(s.id)).map((s) => s.id);
              for (const result of next(value, ends.length ? ends : after)) {
                yielded = true;
                yield result;
              }
            }
          }
        }
        if (!yielded && spec.optional) {
          yield* next(
            { ...draft, notes: [...draft.notes, spec.id + '：可选步骤不可用，已略过'] },
            after,
          );
        }
      }
      yield* walk(0, initial, {});
    }
    for (const result of expand(tasks, '', [], { steps: [], methods: [], notes: [] }, 0)) {
      orderedTasks(result.steps);
      return { ...result, expanded };
    }
    return undefined;
  }
}
