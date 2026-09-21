import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  assert,
  CommandRuntime,
  DEFAULT_POLICY,
  DEFAULT_STYLE,
  errorMessage,
  MemoryPlanStore,
  PROFILES,
  validateGoals,
} from '@jev/core';
import type {
  Commander,
  DecisionProvider,
  Goal,
  PlanStore,
  TextExtractor,
  NarrativeSource,
  NarrativeMessage,
  Json,
  Checkpoint,
  PlanPatch,
} from '@jev/core';
import { DemoAdapter, createObservation, defaultCommanders } from '@jev/demo';
import type { Configuration } from './config.js';
import { FilePlanStore } from './file-store.js';
export interface ServiceOptions {
  configuration?: Configuration;
  dataDirectory?: string;
  store?: PlanStore;
  provider?: DecisionProvider;
  extractor?: TextExtractor;
  narrative?: NarrativeSource;
  token?: string;
  allowedOrigins?: string[];
  uiDirectory?: string;
  tickDelayMs?: number;
}
export function createService(options: ServiceOptions = {}) {
  const store =
    options.store ??
    (options.dataDirectory ? new FilePlanStore(options.dataDirectory) : new MemoryPlanStore());
  const sessions = new Map<string, { runtime: CommandRuntime; adapter: DemoAdapter }>();
  const narrativeMessages = new Map<string, NarrativeMessage[]>();
  async function session(id: string, kind = 'grid') {
    assert(/^[a-zA-Z0-9_.-]{1,100}$/.test(id), 'invalid session id');
    const existing = sessions.get(id);
    if (existing) return existing;
    const cp = await store.load(id);
    const adapter = new DemoAdapter(createObservation(kind, id));
    if (cp) await adapter.restore(cp.host);
    const runtime = new CommandRuntime({
      adapter,
      store,
      commanders: options.configuration?.commanders ?? defaultCommanders(),
      goals: options.configuration?.goals ?? [],
      policy: {
        ...options.configuration?.policy,
        tickDelayMs: options.tickDelayMs ?? options.configuration?.policy?.tickDelayMs ?? 100,
      },
      profiles: { ...PROFILES, ...options.configuration?.profiles },
      ...(options.configuration?.workflow ? { workflow: options.configuration.workflow } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.extractor ? { extractor: options.extractor } : {}),
      narrative: options.narrative ?? { recent: async () => narrativeMessages.get(id) ?? [] },
    });
    await runtime.initialize();
    const entry = { runtime, adapter };
    sessions.set(id, entry);
    return entry;
  }
  const inflight = new Map<string, Promise<Awaited<ReturnType<typeof session>>>>();
  function get(id: string, kind?: string) {
    let p = inflight.get(id);
    if (!p) {
      p = session(id, kind).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    return p;
  }
  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  };
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = '';
    for await (const chunk of req) {
      raw += String(chunk);
      assert(raw.length <= 1_000_000, 'request too large');
    }
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    assert(value && typeof value === 'object' && !Array.isArray(value), 'body must be object');
    return value as Record<string, unknown>;
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) send(res, 400, { error: errorMessage(error) });
      else res.end();
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host ?? '';
    assert(/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host), 'invalid local host');
    const origin = req.headers.origin;
    const sameOrigin = origin === `http://${host}`;
    const allowed = !origin || sameOrigin || options.allowedOrigins?.includes(origin);
    if (!allowed) {
      send(res, 403, { error: 'origin not allowed' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/') && options.token) {
      const provided = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const expected = Buffer.from(options.token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        send(res, 401, { error: 'invalid service token' });
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      const runtime = new CommandRuntime({
        adapter: new DemoAdapter(),
        store,
        commanders: defaultCommanders(),
      });
      send(res, 200, {
        version: '0.1.0',
        mode: 'silent-auto',
        provider: options.provider?.id ?? 'local',
        profiles: { ...PROFILES, ...options.configuration?.profiles },
        styles: runtime.styles.all().map(({ contribution, ...d }) => d),
        doctrines: runtime.doctrines.all().map(({ id, label, family }) => ({ id, label, family })),
        defaults: { policy: DEFAULT_POLICY, style: DEFAULT_STYLE },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const input = await body(req);
      const kind = input.kind ?? 'grid';
      assert(kind === 'grid' || kind === 'regions', 'unknown demo map');
      const id = typeof input.id === 'string' ? input.id : `demo-${randomUUID()}`;
      const { runtime, adapter } = await get(id, kind);
      if (input.auto !== false) runtime.notify();
      send(res, 201, { id, state: runtime.state, observation: await adapter.observe() });
      return;
    }
    const match = /^\/api\/sessions\/([a-zA-Z0-9_.-]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
    if (match) {
      const id = match[1]!,
        operation = match[2];
      const { runtime, adapter } = await get(id);
      if (req.method === 'GET') {
        if (operation === 'export') {
          send(res, 200, await runtime.exportCheckpoint());
          return;
        }
        if (operation === 'actions') {
          const o = await adapter.observe();
          send(
            res,
            200,
            await adapter.legalActions(
              o,
              runtime.state.commanders.flatMap((c) => c.unitIds),
            ),
          );
          return;
        }
        send(res, 200, { id, state: runtime.state, observation: await adapter.observe() });
        return;
      }
      assert(req.method === 'POST', 'method not allowed');
      const input = await body(req);
      switch (operation) {
        case 'start':
          void runtime.resume().catch(() => {});
          break;
        case 'pause':
          await runtime.pause();
          break;
        case 'step':
          await runtime.singleStep();
          break;
        case 'goals': {
          assert(Array.isArray(input.goals), 'goals required');
          const goals = (input.goals as Goal[]).map((g) => ({ ...g, source: 'user' as const }));
          validateGoals(goals, await adapter.observe());
          await runtime.updateGoals(goals);
          break;
        }
        case 'commander':
          assert(
            typeof input.id === 'string' &&
              typeof input.ability === 'string' &&
              input.style &&
              typeof input.style === 'object' &&
              !Array.isArray(input.style),
            'invalid commander update',
          );
          await runtime.updateCommander(input.id, {
            ability: input.ability as Commander['ability'],
            style: input.style as Record<string, number>,
          });
          break;
        case 'lock':
          assert(
            typeof input.taskId === 'string' && typeof input.locked === 'boolean',
            'invalid lock',
          );
          await runtime.patch({
            baseVersion: runtime.state.plan.version,
            source: 'user',
            reason: '调试面板调整任务锁定',
            events: [],
            scope: [],
            lock: { taskId: input.taskId, locked: input.locked },
          });
          break;
        case 'manual':
          assert(typeof input.actionId === 'string', 'action required');
          await runtime.manual(input.actionId);
          break;
        case 'narrative': {
          if (input.messages !== undefined) {
            assert(
              Array.isArray(input.messages) && input.messages.length <= 100,
              'invalid narrative window',
            );
            for (const m of input.messages as NarrativeMessage[])
              assert(
                typeof m.id === 'string' &&
                  typeof m.role === 'string' &&
                  typeof m.text === 'string' &&
                  typeof m.completed === 'boolean',
                'invalid narrative message',
              );
            narrativeMessages.set(id, input.messages as NarrativeMessage[]);
          }
          await runtime.scanNarrative();
          break;
        }
        case 'restore-plan':
          assert(input.plan && typeof input.plan === 'object', 'plan required');
          await runtime.restorePlan(input.plan as Checkpoint['plan']);
          break;
        case 'event': {
          assert(input.kind === 'blocked' || input.kind === 'loss', 'unknown demo event');
          const o = await adapter.observe();
          if (input.kind === 'blocked') {
            assert(
              typeof input.location === 'string' &&
                o.map.locations.some((l) => l.id === input.location),
              'unknown location',
            );
            assert(
              !o.units.some((u) => u.hp > 0 && u.location === input.location),
              'location occupied',
            );
            adapter.inject(
              { id: `block-${o.version + 1}`, kind: 'blocked', location: input.location },
              (state) => {
                state.map.locations.find((l) => l.id === input.location)!.blocked = true;
              },
            );
          } else {
            assert(
              typeof input.unitId === 'string' && o.units.some((u) => u.id === input.unitId),
              'unknown unit',
            );
            adapter.inject(
              { id: `loss-${o.version + 1}`, kind: 'loss', unitIds: [input.unitId] },
              (state) => {
                state.units.find((u) => u.id === input.unitId)!.hp = 0;
              },
            );
          }
          break;
        }
        default:
          send(res, 404, { error: 'unknown operation' });
          return;
      }
      send(res, 200, { id, state: runtime.state, observation: await adapter.observe() });
      return;
    }
    if (req.method === 'GET' && options.uiDirectory) {
      const base = resolve(options.uiDirectory);
      const relative =
        url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const file = resolve(base, relative);
      assert(file.startsWith(base + sep), 'invalid asset path');
      try {
        assert((await stat(file)).isFile(), 'not file');
        const content = await readFile(file);
        const mime: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
        };
        res.writeHead(200, {
          'content-type': mime[extname(file)] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; frame-ancestors 'none'",
        });
        res.end(content);
        return;
      } catch {
        send(res, 404, { error: 'asset not found; run npm run build' });
        return;
      }
    }
    send(res, 404, { error: 'not found' });
  }
  return {
    server,
    sessions,
    getSession: get,
    async close() {
      for (const { runtime } of sessions.values()) await runtime.pause();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
