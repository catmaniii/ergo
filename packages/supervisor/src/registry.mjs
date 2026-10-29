// 注册表：一服务一文件，服务清单只有管理器这一份，不散在各项目仓库里。保存/加载时即校验，循环依赖在这里就拒绝，不留到启动时死锁。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MANAGER_YAML, SERVICES_DIR, OWNED_DIR } from './paths.mjs';
import { exposureErrors } from './exposure.mjs';

export const TIERS = ['process', 'port', 'health', 'linked'];
export const ALL_CAPS = ['start', 'stop', 'restart', 'health', 'busy'];

const DEFAULT_MANAGER = {
  bind: '127.0.0.1',
  port: 7420,
  probeIntervalMs: 5000,
  sentinels: { port: true, scheduledTask: true, intervalMs: 60000 },
  ignorePorts: [],
  profiles: {},
  auth: { enabled: false, passwordFile: '.secrets/webui-password.txt' },
};

export function loadManager() {
  let raw = {};
  try { raw = YAML.parse(fs.readFileSync(MANAGER_YAML, 'utf-8')) || {}; } catch {}
  return {
    ...DEFAULT_MANAGER, ...raw,
    sentinels: { ...DEFAULT_MANAGER.sentinels, ...raw.sentinels },
    auth: { ...DEFAULT_MANAGER.auth, ...raw.auth },
    profiles: raw.profiles || {},
  };
}

function normalizeHook(h) {
  if (!h) return null;
  const hook = typeof h === 'string' ? { cmd: h } : { ...h };
  // argv 形式（数组）优先于 cmd（字符串）：不经 shell 包装 → 不会被 Windows Terminal
  // 开成可见窗口。适合"一条命令就够"的服务，比如 ssh 隧道。
  if (Array.isArray(hook.argv) && hook.argv.length) hook.cmd ??= hook.argv.join(' ');
  hook.timeoutMs ??= 120000;
  hook.readyTimeoutMs ??= 60000;
  hook.detaches ??= false;
  return hook;
}

/** 能力以「真有什么」为准，不足即灰显，绝不外挂伪造。 */
function deriveCapabilities(svc) {
  if (Array.isArray(svc.capabilities)) return svc.capabilities.filter((c) => ALL_CAPS.includes(c));
  const caps = [];
  if (svc.hooks?.start) caps.push('start');
  if (svc.hooks?.stop) caps.push('stop');
  if (svc.hooks?.restart || (svc.hooks?.start && svc.hooks?.stop)) caps.push('restart');
  if (svc.probe?.health?.url) caps.push('health');
  return caps;
}

/**
 * 名下的服务（docs/link-protocol.md §7）的 id = `<登记方>--<名字>`。归属**只看文件放在哪**（services/owned/<登记方>/），
 * 不看文件里写了什么——否则在顶层手写一份 `owner: ergo-daemon`，就等于把自己的服务送进别人手里。
 */
export const OWNED_SEP = '--';
export const ownedIdOf = (owner, name) => `${owner}${OWNED_SEP}${name}`;

/** 一份服务声明在注册表里该叫什么：顶层文件 = 文件名；名下的服务 = 登记方--文件名。 */
function expectedIdOf(file, owner) {
  const base = path.basename(file, '.yaml');
  return owner ? ownedIdOf(owner, base) : base;
}

export function validate(svc, file, errors) {
  const at = (m) => errors.push(`${svc.owner ? `owned/${svc.owner}/` : ''}${path.basename(file)}: ${m}`);
  const expectedId = expectedIdOf(file, svc.owner);
  if (!svc.id) at('缺少 id');
  else if (svc.id !== expectedId) at(`id "${svc.id}" 与文件名不一致，应为 "${expectedId}"`);
  if (svc.owner && svc._rawOwner != null && svc._rawOwner !== svc.owner) at(`owner "${svc._rawOwner}" 与所在目录 owned/${svc.owner}/ 不一致`);
  if (!svc.owner && svc._rawOwner != null) at('owner 只能出现在 services/owned/<登记方>/ 下的文件里——归属看文件放在哪，顶层文件写了也不算');
  if (!svc.root) at('缺少 root（钩子的工作目录）');
  else if (!fs.existsSync(svc.root)) at(`root 不存在：${svc.root}`);
  if (!['managed', 'external'].includes(svc.kind)) at(`kind 必须是 managed 或 external，得到 "${svc.kind}"`);
  const tier = svc.probe?.tier;
  if (!TIERS.includes(tier)) at(`probe.tier 必须是 ${TIERS.join('/')}，得到 "${tier}"`);
  if (['port', 'health', 'linked'].includes(tier) && !svc.probe?.port) at(`${tier} 档必须声明 probe.port——端口是服务的身份`);
  if (tier === 'health' && !svc.probe?.health?.url) at('health 档必须声明 probe.health.url');
  // process 档没有「靠端口认人」这条退路：要么钩子自己 detach 后留下 PID 文件，
  // 要么让管理器自己 detached spawn（detaches: false）——那样 PID 由管理器直接持有。
  if (tier === 'process' && svc.kind === 'managed'
      && !svc.probe?.pidFile && !svc.probe?.matchCmd && svc.hooks?.start?.detaches !== false) {
    at('process 档必须三选一：probe.pidFile / probe.matchCmd / hooks.start.detaches=false（交给管理器 spawn）');
  }
  if (svc.kind === 'managed' && !svc.hooks?.start && !svc.link?.enabled) at('managed 服务必须有 start 钩子');
  for (const m of exposureErrors(svc.exposure)) at(m);
  for (const [n, h] of Object.entries(svc.hooks || {})) {
    if (h && !h.cmd && !h.argv) at(`hooks.${n} 必须给 cmd（字符串）或 argv（数组）`);
    if (h?.argv && !Array.isArray(h.argv)) at(`hooks.${n}.argv 必须是数组`);
  }
  for (const e of svc.env || []) {
    if (!e.name) at('env 条目缺少 name');
    if (!['userEnv', 'file', 'literal'].includes(e.from)) at(`env ${e.name}: from 必须是 userEnv/file/literal`);
    if (e.from === 'file' && !e.path) at(`env ${e.name}: from=file 必须给 path`);
    if (e.from === 'literal' && e.value == null) at(`env ${e.name}: from=literal 必须给 value`);
  }
}

/**
 * 一份 YAML 解析出来的对象 → 管理器内部用的服务对象。加载注册表和「名下的服务」登记前的预检共用它，
 * 两边的规矩因此只有一份（经协议登记的服务照注册表的规矩校验，不另起一套）。
 * owner：这份文件在 services/owned/<owner>/ 下时给出，顶层文件为 null。
 */
export function parseService(raw, file, owner = null) {
  const svc = {
    id: raw.id, name: raw.name || raw.id, project: raw.project || '', root: raw.root,
    kind: raw.kind || 'managed',
    // role: tunnel —— 纯隧道，UI 上不单独占卡片，作为被暴露服务的一部分显示
    role: raw.role || null,
    // 名下的服务：由哪个接入的项目经协议登记。只由所在目录决定，见 validate
    owner: owner || null,
    _rawOwner: raw.owner ?? null,
    registeredAt: raw.registeredAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    probe: {
      tier: raw.probe?.tier, port: raw.probe?.port ?? null,
      health: raw.probe?.health || null, intervalMs: raw.probe?.intervalMs ?? null,
      pidFile: raw.probe?.pidFile ?? null,
      matchCmd: raw.probe?.matchCmd ?? null,
      // 同一个服务占的其它端口（比如信令口 = 主端口+1 这种隐式约定）。
      // 不认它们，哨兵就会把自家服务当成「未纳管」每轮报一次。
      extraPorts: raw.probe?.extraPorts || [],
    },
    link: { enabled: !!raw.link?.enabled },
    hooks: {
      start: normalizeHook(raw.hooks?.start), stop: normalizeHook(raw.hooks?.stop),
      restart: normalizeHook(raw.hooks?.restart),
    },
    env: raw.env || [], logs: raw.logs || [],
    exposure: raw.exposure || null,
    dependsOn: (raw.dependsOn || []).map((d) => (typeof d === 'string' ? { id: d, type: 'hard' } : { type: 'hard', ...d })),
    autoRestart: { enabled: false, maxRetries: 5, backoffMs: [5000, 15000, 60000], ...raw.autoRestart },
    profiles: raw.profiles || [], onboarding: raw.onboarding || {},
    _file: file,
  };
  svc.capabilities = deriveCapabilities({ ...svc, capabilities: raw.capabilities });
  return svc;
}

/** 要读的文件：顶层 services/*.yaml，加上 services/owned/<登记方>/*.yaml。 */
function serviceFiles() {
  const out = [];
  try {
    for (const f of fs.readdirSync(SERVICES_DIR)) if (f.endsWith('.yaml')) out.push({ file: path.join(SERVICES_DIR, f), label: f, owner: null });
  } catch { return out; }
  let owners = [];
  try { owners = fs.readdirSync(OWNED_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const owner of owners) {
    let files = [];
    try { files = fs.readdirSync(path.join(OWNED_DIR, owner)).filter((f) => f.endsWith('.yaml')); } catch {}
    for (const f of files) out.push({ file: path.join(OWNED_DIR, owner, f), label: `owned/${owner}/${f}`, owner });
  }
  return out;
}

export function loadServices() {
  const errors = [];
  const services = new Map();
  for (const { file, label, owner } of serviceFiles()) {
    let raw;
    try { raw = YAML.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { errors.push(`${label}: YAML 解析失败 — ${e.message}`); continue; }
    if (!raw || typeof raw !== 'object') { errors.push(`${label}: 空文件`); continue; }

    const svc = parseService(raw, file, owner);
    validate(svc, file, errors);
    if (services.has(svc.id)) errors.push(`${label}: id "${svc.id}" 重复`);
    services.set(svc.id, svc);
  }

  for (const svc of services.values()) {
    // 公网暴露必须指到一条真实存在的隧道服务上——否则「公网已接通」这个标记就是骗人的
    if (svc.exposure?.via && !services.has(svc.exposure.via)) {
      errors.push(`${svc.id}: exposure.via 指向的隧道服务 "${svc.exposure.via}" 不存在`);
    }
    for (const d of svc.dependsOn) {
      if (!services.has(d.id)) errors.push(`${svc.id}: 依赖的 "${d.id}" 不存在`);
      if (!['hard', 'soft'].includes(d.type)) errors.push(`${svc.id}: 依赖 "${d.id}" 的 type 必须是 hard 或 soft`);
    }
  }
  for (const cyc of findCycles(services)) errors.push(`循环依赖：${cyc.join(' → ')}`);
  return { services, errors };
}

export function findCycles(services) {
  const cycles = [];
  const state = new Map();   // 0=未访问 1=在栈上 2=已完成
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { cycles.push([...stack.slice(stack.indexOf(id)), id]); return; }
    if (!services.has(id)) return;
    state.set(id, 1); stack.push(id);
    for (const d of services.get(id).dependsOn) visit(d.id);
    stack.pop(); state.set(id, 2);
  };
  for (const id of services.keys()) visit(id);
  return cycles;
}

/** 依赖拓扑分层：同层可并发，层间串行。软依赖不参与阻塞，但仍影响顺序。 */
export function topoLayers(services, ids) {
  const want = new Set();
  const collect = (id) => {
    if (want.has(id) || !services.has(id)) return;
    want.add(id);
    for (const d of services.get(id).dependsOn) collect(d.id);
  };
  ids.forEach(collect);

  const layers = [];
  const done = new Set();
  let guard = 0;
  while (done.size < want.size && guard++ < 100) {
    const layer = [...want].filter((id) => !done.has(id)
      && services.get(id).dependsOn.every((d) => !want.has(d.id) || done.has(d.id)));
    if (!layer.length) break;
    layer.forEach((id) => done.add(id));
    layers.push(layer);
  }
  return layers;
}
