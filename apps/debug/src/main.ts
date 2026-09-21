import './style.css';
import type {
  Ability,
  BattleAction,
  Checkpoint,
  Commander,
  Goal,
  Observation,
  Task,
} from '@jev/core';
import type { CommandRuntime } from '@jev/core';
type RuntimeState = CommandRuntime['state'];
type View = { id: string; state: RuntimeState; observation: Observation };
type Meta = {
  version: string;
  provider: string;
  styles: { id: string; label: string; low: string; high: string; effect: string }[];
  profiles: Record<string, { label: string; candidateLimit: number; horizon: number }>;
  doctrines: { id: string; label: string; family: string }[];
};
const app = document.querySelector<HTMLDivElement>('#app')!;
let meta: Meta;
let current: View | undefined;
let selectedCommander = 'blue';
let sessionId = localStorage.getItem('jev-session') ?? '';
let busy = false;
let pendingOperations = 0;
let token = '';
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const labels: Record<string, string> = {
  idle: '就绪',
  running: '自动指挥中',
  paused: '已暂停',
  waiting: '等待宿主',
  degraded: '本地接管',
  stopped: '提交已停止',
  ended: '战斗结束',
  strategy: '总目标',
  campaign: '分队指挥',
  tactics: '当前战法',
  blue: '蓝方',
  red: '红方',
  draw: '平局',
  attack: '进攻',
  defend: '防御',
  withdraw: '撤退',
  move: '移动',
  recon: '侦察',
  wait: '待命',
  eliminate: '击退对手',
  capture: '占领',
  hold: '坚守',
  support: '支援',
  assault: '突击',
  flank: '侧翼',
  reserve: '预备队',
  fix: '牵制',
  screen: '警戒',
  cover: '掩护',
  independent: '独立行动',
};
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败 ${response.status}`);
  return result as T;
}
function note(message: string, error = false) {
  const el = document.querySelector('#notice');
  if (el) {
    el.textContent = message;
    el.className = error ? 'notice error' : 'notice';
  }
}
function shell() {
  app.innerHTML = `
 <header><a class="brand" href="/" aria-label="JEV 指挥室"><span class="sigil">✦</span><span>JEV <small>指挥室</small></span></a><div class="header-right"><span class="quiet">通用指挥决策框架</span><span class="version">v${esc(meta.version)}</span><span class="provider">${meta.provider === 'jev' ? 'Jev 已配置' : '本地规则'}</span></div></header>
 <div class="workspace"><aside class="sidebar"><div class="eyebrow">COMMANDER / 指挥官</div><select id="commander" aria-label="选择指挥官"></select><section class="control-section"><label for="ability">指挥能力</label><select id="ability">${Object.entries(
   meta.profiles,
 )
   .map(([id, p]) => `<option value="${esc(id)}">${esc(p.label)}</option>`)
   .join(
     '',
   )}</select><p id="ability-description" class="muted"></p></section><div class="row"><h2>个人风格</h2><button id="reset-styles" class="text-button">归中</button></div><p class="muted small">50 为中性。偏好始终服从合法动作与战场条件。</p><div id="sliders">${meta.styles.map((s) => `<div class="slider"><label for="style-${s.id}">${esc(s.label)}<output id="value-${s.id}">50</output></label><input id="style-${s.id}" data-style="${s.id}" type="range" min="0" max="100" step="1" value="50" title="${esc(s.effect)}"><div class="range-labels"><span>${esc(s.low)}</span><span>${esc(s.high)}</span></div></div>`).join('')}</div><button class="primary full" id="apply-commander">应用指挥设置</button><p class="muted small">设置会自动保存，在下一决策边界生效。</p></aside>
 <main><div class="heading"><div><div class="eyebrow">BATTLE OVERVIEW / 战局</div><h1>让计划持续推进。</h1><p class="subtitle">自动执行、动态改案、可恢复。随时接管。</p></div><div class="status"><i></i><span id="status-text">就绪</span></div></div>
 <div class="toolbar"><select id="map-kind" aria-label="示例地图"><option value="grid">方格战场</option><option value="regions">区域连接图</option></select><button id="new-battle">新建战斗</button><span class="spacer"></span><button id="step">单步</button><button id="pause">暂停</button><button id="start" class="primary">自动运行</button><button id="export">导出</button></div><div id="notice" class="notice" role="status">正常运行无需打开此面板，也无需逐步确认。</div>
 <div class="stats"><div><span>当前回合</span><strong id="turn">—</strong></div><div><span>计划版本</span><strong id="plan-version">—</strong></div><div><span>已结算行动</span><strong id="actions">—</strong></div><div><span>保存检查点</span><strong id="saved">—</strong></div></div>
 <div class="battle-grid"><section class="card map-card"><div class="card-title"><h2>战场态势</h2><div class="legend"><span class="blue-dot">蓝方</span><span class="red-dot">红方</span><span>◆ 目标</span></div></div><div id="map" aria-label="战场地图"></div><div id="map-caption" class="map-caption"></div><div id="roster" class="roster"></div></section>
 <section class="card"><div class="card-title"><h2>总计划与任务</h2><span class="tag">持续保存</span></div><div id="goals"></div><div id="tasks"></div></section></div>
 <div class="bottom-grid"><section class="card"><div class="card-title"><h2>主动介入</h2><span class="muted small">可选</span></div><div class="form-row"><label>目标方向<select id="goal-kind"><option value="capture">占领据点</option><option value="defend">坚守据点</option><option value="withdraw">撤至指定位置</option><option value="recon">侦察指定位置</option></select></label><label>位置<select id="goal-target"></select></label><button id="set-goal">更新目标</button></div><div class="form-row"><label class="grow">手动行动<select id="manual-action"></select></label><button id="manual">执行命令</button></div><p class="muted small">手动命令优先；其余授权单位继续由指挥系统管理。</p></section><section class="card"><div class="card-title"><h2>修订记录</h2><span id="revision-count" class="muted small"></span></div><div id="history" class="history"></div></section></div>
 <details class="card analysis"><summary>查看候选评分与执行记录</summary><div id="metrics" class="muted"></div><div class="table-wrap"><table><thead><tr><th>候选</th><th>任务收益</th><th>风险</th><th>风格</th><th>综合</th></tr></thead><tbody id="scores"></tbody></table></div><div id="log" class="log"></div></details><footer>观察来自宿主 · 决策范围受授权限制 · 模型故障自动使用本地规则</footer></main></div>`;
  wire();
}
function commanderControls() {
  if (!current) return;
  const commands = current.state.commanders;
  const select = document.querySelector<HTMLSelectElement>('#commander')!;
  select.innerHTML = commands
    .map(
      (c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.parentId ? ' · 分队' : ''}</option>`,
    )
    .join('');
  select.value = selectedCommander;
  const c = commands.find((c) => c.id === selectedCommander) ?? commands[0]!;
  selectedCommander = c.id;
  document.querySelector<HTMLSelectElement>('#ability')!.value = c.ability;
  for (const d of meta.styles) {
    document.querySelector<HTMLInputElement>(`#style-${d.id}`)!.value = String(c.style[d.id] ?? 50);
    document.querySelector(`#value-${d.id}`)!.textContent = String(c.style[d.id] ?? 50);
  }
  abilityDescription();
}
function abilityDescription() {
  const id = document.querySelector<HTMLSelectElement>('#ability')!.value;
  const p = meta.profiles[id]!;
  document.querySelector('#ability-description')!.textContent =
    `每节点最多考虑 ${p.candidateLimit} 个方案，提前细化 ${p.horizon} 个阶段。`;
}
function mapSvg(o: Observation) {
  const cell = 54,
    pad = 38;
  const maxX = Math.max(...o.map.locations.map((l) => l.x)),
    maxY = Math.max(...o.map.locations.map((l) => l.y));
  const sx = (x: number) => pad + x * cell,
    sy = (y: number) => pad + y * cell;
  let svg = `<svg role="img" aria-label="第 ${o.turn} 回合战场" viewBox="0 0 ${(maxX + 1) * cell + pad} ${(maxY + 1) * cell + pad}">`;
  if (o.map.kind === 'regions')
    for (const l of o.map.locations)
      for (const neighbor of l.neighbors) {
        const other = o.map.locations.find((n) => n.id === neighbor)!;
        if (l.id < neighbor)
          svg += `<line x1="${sx(l.x)}" y1="${sy(l.y)}" x2="${sx(other.x)}" y2="${sy(other.y)}" stroke="#33454d" stroke-width="4"/>`;
      }
  for (const l of o.map.locations) {
    const x = sx(l.x),
      y = sy(l.y);
    svg +=
      o.map.kind === 'grid'
        ? `<rect x="${x - 23}" y="${y - 23}" width="46" height="46" rx="5" fill="${l.blocked ? '#495254' : l.cover ? '#253d37' : '#1c2b30'}" stroke="#344447" stroke-width=".6"/>`
        : `<circle cx="${x}" cy="${y}" r="23" fill="${l.blocked ? '#495254' : '#22373a'}" stroke="#50615c"/>`;
    if (l.blocked)
      svg += `<path d="M${x - 7},${y + 7} L${x},${y - 9} L${x + 7},${y + 7}Z" fill="#7c8680"/>`;
    if (o.map.kind === 'regions')
      svg += `<text x="${x}" y="${y + 37}" text-anchor="middle" fill="#9daba7" font-size="10">${esc(l.label)}</text>`;
    const goal = current?.state.goals.find((g) => g.target === l.id);
    if (goal)
      svg += `<path d="M${x},${y - 12} L${x + 10},${y} L${x},${y + 12} L${x - 10},${y}Z" fill="none" stroke="#d1b373" stroke-width="2"/>`;
  }
  for (const u of o.units) {
    const l = o.map.locations.find((l) => l.id === u.location);
    if (!l) continue;
    const x = sx(l.x),
      y = sy(l.y);
    if (u.hp <= 0) {
      svg += `<text x="${x}" y="${y + 5}" text-anchor="middle" fill="#687170" font-size="18">×</text>`;
      continue;
    }
    const color = u.side === 'blue' ? '#67b6d9' : '#dd8079';
    svg += `<g><title>${esc(u.name)} · HP ${u.hp}/${u.maxHp} · AP ${u.ap}</title><circle cx="${x}" cy="${y}" r="16" fill="${color}" opacity="${u.ap > 0 ? '1' : '.45'}"/><text x="${x}" y="${y + 4}" text-anchor="middle" fill="#10252c" font-size="11" font-weight="700">${esc(u.id.toUpperCase())}</text><rect x="${x - 16}" y="${y + 20}" width="32" height="3" rx="1" fill="#101e21"/><rect x="${x - 16}" y="${y + 20}" width="${(32 * u.hp) / u.maxHp}" height="3" rx="1" fill="${color}"/></g>`;
  }
  return svg + '</svg>';
}
function render() {
  if (!current) return;
  const { state: s, observation: o } = current;
  document.querySelector('#status-text')!.textContent = labels[s.status.state] ?? s.status.state;
  document.querySelector('.status')!.setAttribute('data-state', s.status.state);
  document.querySelector('#turn')!.textContent = String(o.turn);
  document.querySelector('#plan-version')!.textContent = `v${s.plan.version}`;
  document.querySelector('#actions')!.textContent = String(s.metrics.actions);
  document.querySelector('#saved')!.textContent = `#${s.status.savedRevision}`;
  document.querySelector('#map')!.innerHTML = mapSvg(o);
  document.querySelector('#map-caption')!.textContent = o.ended
    ? `战斗结束 · ${labels[o.winner ?? 'draw'] ?? o.winner}`
    : `${labels[o.activeSide] ?? o.activeSide}行动中 · ${o.map.kind === 'grid' ? '灰色为障碍，深绿为掩体' : '区域之间沿连线通行'} · 状态 ${o.version}`;
  document.querySelector('#roster')!.innerHTML = o.units
    .map(
      (u) =>
        `<div class="unit"><b class="${u.side === 'blue' ? 'blue' : 'red'}">${esc(u.name)}</b><span>${u.hp > 0 ? `${u.hp} / ${u.maxHp}` : '失去战斗力'}</span><small>AP ${u.ap} · 弹药 ${u.ammo}</small></div>`,
    )
    .join('');
  document.querySelector('#goals')!.innerHTML =
    s.goals
      .map(
        (g) =>
          `<div class="goal"><span class="${g.side === 'blue' ? 'blue' : 'red'}">◆</span><div><b>${esc(g.title)}</b><small>${g.source === 'user' ? '手动指定' : g.source === 'host' ? '宿主目标' : '正文补齐'} · 优先级 ${g.priority}</small></div></div>`,
      )
      .join('') || '<p class="muted">等待首次决策生成目标</p>';
  document.querySelector('#tasks')!.innerHTML =
    s.plan.tasks
      .filter((t) => t.level === 'tactics')
      .map((t) => taskView(t, s))
      .join('') || '<div class="empty">计划将在首次决策时自动生成。</div>';
  document.querySelector('#history')!.innerHTML =
    s.revisions
      .slice(-5)
      .reverse()
      .map(
        (r) =>
          `<div class="revision"><span>v${r.to}</span><div>${esc(r.reason)}<small>${esc(r.scope.map((id) => s.commanders.find((c) => c.id === id)?.name ?? id).join(' · '))}</small></div></div>`,
      )
      .join('') || '<p class="muted">尚无修订</p>';
  document.querySelector('#revision-count')!.textContent = `${s.revisions.length} 次`;
  document.querySelector('#metrics')!.textContent =
    `累计评估 ${s.metrics.evaluations} 项 · 降级 ${s.metrics.fallbacks} 次 · 丢弃过期响应 ${s.metrics.stale} 次 · 当前候选 ${s.metrics.lastCandidates} 个`;
  document.querySelector('#scores')!.innerHTML = s.candidates
    .map(
      (c) =>
        `<tr><td>${esc(c.label)}</td><td>${c.utility.toFixed(2)}</td><td>${c.risk.toFixed(2)}</td><td>${c.style.toFixed(2)}</td><td>${c.total.toFixed(2)}</td></tr>`,
    )
    .join('');
  document.querySelector('#log')!.innerHTML = s.receipts
    .slice(-12)
    .reverse()
    .map((r) => `<div><span>#${r.stateVersion}</span>${esc(r.detail)}</div>`)
    .join('');
  document.querySelector<HTMLButtonElement>('#start')!.disabled = o.ended;
  document.querySelector<HTMLButtonElement>('#step')!.disabled = o.ended;
  if (s.status.state === 'stopped') note(s.status.detail, true);
  const target = document.querySelector<HTMLSelectElement>('#goal-target')!;
  if (target.options.length !== o.map.locations.length)
    target.innerHTML = o.map.locations
      .map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`)
      .join('');
}
function taskView(t: Task, s: RuntimeState) {
  const commander = s.commanders.find((c) => c.id === t.commanderId);
  const p = s.progress[t.id];
  const d = meta.doctrines.find((d) => d.id === t.doctrineId);
  return `<div class="task"><div class="row"><span class="muted small">${esc(commander?.name)}</span><button class="text-button lock" data-task="${esc(t.id)}" data-locked="${t.locked}">${t.locked ? '解锁' : '锁定'}</button></div><h3>${esc(d?.label ?? t.doctrineId)}</h3><div class="phase">${p?.status === 'completed' ? '任务已完成' : esc(t.phases[p?.phase ?? 0]?.title ?? '准备中')}</div><div class="phase-dots">${t.phases.map((_, i) => `<i class="${i <= (p?.phase ?? 0) ? 'active' : ''}"></i>`).join('')}</div><div class="role-tags">${s.assignments
    .filter((a) => a.taskId === t.id)
    .map(
      (a) =>
        `<span>${esc(a.unitId.toUpperCase())} ${labels[a.role] ?? esc(a.role)}${a.committed ? '' : ' · 待命'}</span>`,
    )
    .join(
      '',
    )}</div>${t.alternatives.length ? `<small class="muted">预案 ${t.alternatives.length} 项 · 已执行 ${p?.actions ?? 0} 次</small>` : ''}</div>`;
}
async function refreshActions() {
  if (!sessionId) return;
  const actions = await api<BattleAction[]>(`sessions/${sessionId}/actions`);
  const select = document.querySelector<HTMLSelectElement>('#manual-action')!;
  const previous = select.value;
  select.innerHTML = actions
    .map(
      (a) =>
        `<option value="${esc(a.id)}">${esc(a.unitId.toUpperCase())} · ${labels[a.kind] ?? esc(a.kind)} ${esc(a.targetId ?? a.destination ?? '')}</option>`,
    )
    .join('');
  if (actions.some((a) => a.id === previous)) select.value = previous;
}
async function run(operation: string, data: unknown = {}) {
  if (!sessionId) return;
  const requestedSession = sessionId;
  const result = await api<View>(`sessions/${requestedSession}/${operation}`, data);
  if (sessionId !== requestedSession) return;
  if (
    current?.id === result.id &&
    current.state.status.savedRevision > result.state.status.savedRevision
  )
    return;
  current = result;
  render();
  await refreshActions();
}
function on(id: string, action: () => Promise<void> | void) {
  document.querySelector(`#${id}`)!.addEventListener('click', () => {
    pendingOperations++;
    busy = true;
    Promise.resolve()
      .then(action)
      .catch((e) => note(String(e.message ?? e), true))
      .finally(() => {
        pendingOperations--;
        busy = pendingOperations > 0;
      });
  });
}
function wire() {
  on('new-battle', async () => {
    current = await api<View>('sessions', {
      kind: document.querySelector<HTMLSelectElement>('#map-kind')!.value,
      auto: false,
    });
    sessionId = current.id;
    localStorage.setItem('jev-session', sessionId);
    commanderControls();
    render();
    await refreshActions();
    note('新战场已建立，点击自动运行或单步测试。');
  });
  on('start', () => run('start'));
  on('pause', () => run('pause'));
  on('step', () => run('step'));
  on('apply-commander', async () => {
    const style = Object.fromEntries(
      meta.styles.map((d) => [
        d.id,
        Number(document.querySelector<HTMLInputElement>(`#style-${d.id}`)!.value),
      ]),
    );
    await run('commander', {
      id: selectedCommander,
      ability: document.querySelector<HTMLSelectElement>('#ability')!.value,
      style,
    });
    note('指挥设置已保存。');
  });
  on('reset-styles', () => {
    for (const d of meta.styles) {
      document.querySelector<HTMLInputElement>(`#style-${d.id}`)!.value = '50';
      document.querySelector(`#value-${d.id}`)!.textContent = '50';
    }
  });
  on('set-goal', async () => {
    const commander = current!.state.commanders.find((c) => c.id === selectedCommander)!;
    const kind = document.querySelector<HTMLSelectElement>('#goal-kind')!.value;
    const target = document.querySelector<HTMLSelectElement>('#goal-target')!.value;
    const old = current!.state.goals.find((g) => g.id === 'mission' && g.side === commander.side);
    await run('goals', {
      goals: [
        {
          id: 'mission',
          title: `${labels[kind] ?? kind} ${target}`,
          kind,
          target,
          priority: 90,
          source: 'user',
          version: (old?.version ?? 0) + 1,
          side: commander.side,
        },
      ],
    });
    note('目标已更新，下一次决策自动修订计划。');
  });
  on('manual', async () => {
    await run('manual', {
      actionId: document.querySelector<HTMLSelectElement>('#manual-action')!.value,
    });
    note('手动命令已结算。');
  });
  on('export', async () => {
    const cp = await api<Checkpoint>(`sessions/${sessionId}/export`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(cp, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `jev-${sessionId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  document.querySelector('#commander')!.addEventListener('change', () => {
    selectedCommander = document.querySelector<HTMLSelectElement>('#commander')!.value;
    commanderControls();
  });
  document.querySelector('#ability')!.addEventListener('change', abilityDescription);
  for (const d of meta.styles)
    document.querySelector(`#style-${d.id}`)!.addEventListener('input', (e) => {
      document.querySelector(`#value-${d.id}`)!.textContent = (e.target as HTMLInputElement).value;
    });
  document.querySelector('#tasks')!.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.lock');
    if (target)
      void run('lock', {
        taskId: target.dataset.task,
        locked: target.dataset.locked !== 'true',
      }).catch((e) => note(e.message, true));
  });
}
async function boot() {
  try {
    meta = await api<Meta>('meta');
    shell();
    if (sessionId) {
      current = await api<View>(`sessions/${sessionId}`);
      commanderControls();
      render();
      await refreshActions();
    } else {
      document.querySelector<HTMLButtonElement>('#new-battle')!.click();
    }
    setInterval(() => {
      if (busy || !sessionId) return;
      void api<View>(`sessions/${sessionId}`)
        .then((v) => {
          const changed = v.observation.version !== current?.observation.version;
          current = v;
          render();
          if (changed) void refreshActions();
        })
        .catch((e) => note(e.message, true));
    }, 600);
  } catch (e) {
    app.innerHTML = `<div class="connect"><span class="sigil">✦</span><h1>连接本机指挥服务</h1><p>${esc((e as Error).message)}</p><label>本机服务令牌<input id="service-token" type="password" autocomplete="off"></label><button id="connect" class="primary">连接</button></div>`;
    document.querySelector('#connect')!.addEventListener('click', () => {
      token = document.querySelector<HTMLInputElement>('#service-token')!.value;
      void boot();
    });
  }
}
void boot();
