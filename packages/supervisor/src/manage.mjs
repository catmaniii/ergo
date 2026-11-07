// 接入层的管理指令（docs/link-protocol.md §9）：接入的项目经它自己那条带身份的连接，看、启停、重启别的服务。
//
// 起因（2026-11-07）：二狗的秘书要能指挥服务管家（启停、重启别的服务），但绝不能把二狗自己、
// 或者二狗活下去离不开的东西停掉。秘书那边的工具会先挡一遍，真正的防线放在这里：按连接的身份算出「命脉」，
// 对命脉的停、杀、撤一律回 protected——不管请求是从哪个工具、哪种写法来的。
//
// 命脉（lifelineOf）不是写死的名单，每条请求都按当时的注册表现算：
//  - 调用方自己；
//  - 它的公网隧道（exposure.via）；
//  - 它开着 tailnet 入口时，manager.yaml 的 tailnet 网关；
//  - 上面这些硬依赖（dependsOn type: hard）的服务，一层层往下（闭包）；
//  - 注册表里标了 `lifeline: true` 的（对谁都是命脉）；
//  - 探活端口就是管理器自己端口的（不该有，有就当命脉：管理器本身不在任何「停」的范围里）。
// 对命脉：启动、取消等空闲再停、开机自启开、公网入口开、tailnet 开、看状态和日志照常；
// 停（优雅和强制）、重启、开机自启关、公网入口关、tailnet 关、裁决孤儿 kill、撤销、含命脉的场景停止一律拒绝。
// 唯一例外是 restartSelf：调用方让管理器「等我空闲了重启我」，收下就回「已排队」，绝不阻塞到重启完
// （二狗的「忙」包括正在执行的这次调用本身，等结果会和自己死锁）。
//
// reload、detach-task、VPS、改口令、开通公网（生成隧道）这条连接上不开放：要人在 WebUI / CLI 上做。
// 名下的服务（别人登记进来的）不能用这些指令：名下只有一层，和 services.* 的规矩一样。
// 每条指令都进审计日志：谁、什么、结果、拒绝原因。
import { topoLayers } from './registry.mjs';
import { exposureOf } from './exposure.mjs';
import { logEntries, tail } from './logs.mjs';
import { hostOf } from './tailnet.mjs';
import { waitFor } from './winproc.mjs';
import { info, warn, audit } from './log.mjs';

/** 写在 welcome.features 里的特性名：管理器支持管理指令。 */
export const FEATURE = 'manage';

/** manage.logs 一次最多给几行、读文件末尾多少字节：给 agent 看的，不是给人翻的整份日志。 */
export const LOG_LINES_DEFAULT = 100;
export const LOG_LINES_MAX = 500;
const LOG_MAX_BYTES = 128 * 1024;

/**
 * restartSelf 等调用方空闲的上限。和「等空闲再停」的默认上限一样是一小时；到点还在忙就两边都撤
 * （服务那边的挂起也撤掉），服务照常跑——不留一个「哪天空闲了自己退、却没人拉它起来」的尾巴。
 */
export const RESTART_SELF_WAIT_MS = 3600000;

/** 这条连接上不开放的（要人在 WebUI / CLI 上做）。 */
const NOT_OPEN = {
  'manage.reload': '重新加载注册表',
  'manage.detachTask': '摘计划任务',
  'manage.setPassword': '改 WebUI 口令',
  'manage.exposeCreate': '开通公网（生成隧道、改注册表）',
};

const UP = ['RUNNING', 'DEGRADED'];
const fail = (code, why, details) => ({ ok: false, code, why, ...(details ? { details } : {}) });

/** 请求里必须有的字符串字段；没有回 bad-request。 */
function need(msg, key, desc) {
  const v = msg[key];
  return typeof v === 'string' && v ? null : fail('bad-request', `${msg.type} 要带 ${key}（${desc}）`);
}

/**
 * 调用方的命脉：Map(id → 为什么，可能有好几条)。纯函数，只读 sup 上的注册表、tailnet 清单、管理器设置。
 */
export function lifelineOf(sup, caller) {
  const out = new Map();
  const add = (id, why) => {
    if (!out.has(id)) out.set(id, []);
    if (!out.get(id).includes(why)) out.get(id).push(why);
  };
  const self = sup.services.get(caller);
  const roots = [];
  if (self) {
    add(caller, '调用方自己');
    roots.push(caller);
    const via = self.exposure?.via;
    if (via && sup.services.has(via)) {
      add(via, `${caller} 的公网隧道（exposure.via）`);
      roots.push(via);
    }
    const gw = sup.manager?.tailnet?.gateway;
    if (gw && sup.tailnetEntries?.has(caller) && sup.services.has(gw)) {
      add(gw, `tailnet 网关（${caller} 开着 tailnet 入口）`);
      roots.push(gw);
    }
  }
  // 硬依赖的闭包：从上面这些出发，一层层往下。软依赖不算（它没开只是降级，比如二狗的语音合成）
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of sup.services.get(id)?.dependsOn || []) {
      if (d.type !== 'hard' || !sup.services.has(d.id)) continue;
      add(d.id, `${id} 硬依赖它`);
      walk(d.id);
    }
  };
  roots.forEach(walk);
  // 对谁都是命脉的：注册表里标了 lifeline: true 的；探活端口就是管理器自己的
  for (const svc of sup.services.values()) {
    if (svc.lifeline === true) add(svc.id, '注册表里标了 lifeline: true');
    if (svc.probe?.port && svc.probe.port === sup.manager?.port) add(svc.id, `端口 ${svc.probe.port} 是服务管家自己的`);
  }
  return out;
}

/** 接上一个 Supervisor。opts.restartSelfWaitMs 只给测试缩短等待用。 */
export function createManage(sup, { restartSelfWaitMs = RESTART_SELF_WAIT_MS } = {}) {
  const locks = new Map();         // 目标 → 排队的尾巴：同一个服务的管理指令一次一个
  const restarting = new Set();    // 正在「等空闲再重启自己」的调用方

  function serial(key, fn) {
    const run = (locks.get(key) || Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    locks.set(key, settled);
    settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
    return run;
  }

  const linkOf = (id) => sup.link?.status?.(id) ?? null;

  /** 和 WebUI 一样的能力口径：接入后 stop / restart / busy 以服务自报为准，start 永远来自注册表。 */
  function capsOf(svc) {
    const link = linkOf(svc.id);
    return link?.connected && link.capabilities
      ? [...new Set([...link.capabilities, ...svc.capabilities.filter((c) => c === 'start')])]
      : svc.capabilities;
  }

  /** 列表里的一条：状态、端口、开机自启、最后一次出错、是不是命脉和原因。 */
  function viewOf(svc, lifeline) {
    if (!svc) return null;
    const st = sup.st(svc.id);
    const exp = exposureOf(svc);
    const entry = sup.tailnetEntries?.get(svc.id);
    const tcfg = sup.manager?.tailnet;
    const why = lifeline?.get(svc.id) || [];
    return {
      id: svc.id, title: svc.name, project: svc.project || null, kind: svc.kind, role: svc.role || null, owner: svc.owner || null,
      port: svc.probe?.port ?? null,
      state: st.state, desired: st.desired || 'stopped', up: UP.includes(st.state),
      listening: st.listening ?? null, health: st.health ?? null, tier: st.tier || svc.probe?.tier || null,
      pid: st.pid ?? null, since: st.runningSince ?? null,
      autostart: !!sup.bootList?.has(svc.id), linked: !!linkOf(svc.id)?.connected,
      busy: !!st.busy, busyReason: st.busyReason || null, pendingStop: !!st.pendingStop,
      capabilities: capsOf(svc),
      detail: st.detail || null, lastError: st.lastError || null,
      profiles: svc.profiles || [], dependsOn: (svc.dependsOn || []).map((d) => ({ id: d.id, type: d.type })),
      exposure: exp.scope === 'public' ? { via: exp.via, publicUrl: exp.publicUrl } : null,
      tailnet: entry && tcfg?.domain ? { name: entry.name, url: `https://${hostOf(entry.name, tcfg)}/` } : null,
      protected: why.length > 0, protectedWhy: why,
      // 注册表里标了 ergo: true：二狗的「服务」页把它也列出来（只是显示，和保护无关）
      ergo: svc.ergo === true,
    };
  }

  /** 这些目标里有命脉就拒：回 protected，details 逐个写清是谁、为什么。 */
  function guard(caller, ids, what) {
    const lifeline = lifelineOf(sup, caller);
    const hits = [...new Set(ids)].filter((id) => lifeline.has(id));
    if (!hits.length) return null;
    const details = hits.map((id) => ({ id, why: lifeline.get(id) }));
    const text = details.map((d) => `${d.id}（${d.why.join('；')}）`).join('、');
    warn(`${caller} 经接入层想${what}，被拒：${text} 是它的命脉`);
    return fail('protected', `不能${what}：${text} 是 ${caller} 的命脉，这条连接上不许停、不许杀、不许撤。要停请你在服务管家的网页或命令行上做`, details);
  }

  /** 单个目标的回复：成功带上这个服务现在的样子；失败照 supervisor 的原因。 */
  const result = (caller, id, r) => {
    const service = viewOf(sup.services.get(id), lifelineOf(sup, caller));
    if (r?.ok) {
      const note = r.pending ? r.why : r.note;
      return {
        ok: true, ...(r.already ? { already: true } : {}), ...(r.pending ? { pending: true } : {}), ...(note ? { note } : {}),
        ...(r.killed ? { killed: r.killed } : {}), ...(r.url ? { url: r.url } : {}),
        ...(service ? { service } : {}),
      };
    }
    return { ...fail(r?.code || 'failed', r?.why || '失败'), ...(service ? { service } : {}) };
  };

  function targetOf(msg) {
    const bad = need(msg, 'name', '服务 id，名下的服务写全名');
    if (bad) return bad;
    const svc = sup.services.get(msg.name);
    return svc ? { ok: true, svc, id: svc.id } : fail('not-found', `没有这个服务：${msg.name}`);
  }

  /** 和 services.restart 同一套：没在跑就是启动；有重启能力按 now 重启；没有就要 force（先杀再起）。 */
  async function restartNow(caller, svc, force) {
    const reason = `${caller} 经接入层管理`;
    // 没在跑的「重启」就是启动。在不在跑看进程和端口，不看账本上的状态
    if (!(await sup.liveness(svc)).running) return sup.start(svc.id, { reason });
    // supervisor.restart 能做的三种：接入了、报了 restart 的走协议；有 restart 钩子；有 stop + start 钩子拼出来
    const link = linkOf(svc.id);
    const viaLink = link?.connected && (link.capabilities || []).includes('restart');
    if (viaLink || svc.hooks?.restart || (svc.hooks?.stop && svc.hooks?.start)) return sup.restart(svc.id, { mode: 'now', reason });
    if (!force) return fail('no-capability', `${svc.id} 没有重启能力（没有停机钩子、也没接入）。要重启就带 force: true——先杀进程树再起，正在进行的工作会丢`);
    const s = await sup.stop(svc.id, { force: true, reason });
    if (!s.ok) return s;
    return sup.start(svc.id, { reason });
  }

  /**
   * 等调用方空闲了重启它：经接入层发 restart（when-idle），它 ack 后进程退出，确认真的没了再按 start 钩子拉起来。
   * 在后台跑（回复「已排队」之后才开始），结果进审计日志和管理器日志。
   */
  async function restartSelfFlow(caller) {
    const reason = `${caller} 经接入层让管理器等它空闲后重启它`;
    const svc = sup.services.get(caller);
    const st = sup.st(caller);
    try {
      st.desired = 'running';
      sup.persist();
      audit('restart', { id: caller, mode: 'when-idle', reason });
      const ack = await sup.link.restart(caller, { mode: 'when-idle', deadlineMs: restartSelfWaitMs });
      if (!ack?.ok) {
        warn(`${caller} 要等空闲后重启自己，但它没有应答重启指令：${ack?.why || '未说明'}——不重启，照常跑`);
        audit('link-manage-restart-self', { caller, phase: 'ack', ok: false, why: ack?.why || null });
        return;
      }
      info(`${caller} 等空闲后重启自己：已排队，它空闲了会自己退出，管理器再把它拉起来`);
      // 连接在 = 进程在，不用起 PowerShell 查进程表；连接断了才去看进程和端口（断了可能只是在重连）。
      // 连着的已经换了一个进程（它退了之后被 autoRestart 抢先拉起来了）：这次重启已经发生，不再起
      const oldPid = linkOf(caller)?.pid ?? null;
      let replaced = false;
      const down = await waitFor(async () => {
        const l = linkOf(caller);
        if (l?.connected) {
          replaced = !!(oldPid && l.pid && l.pid !== oldPid);
          return replaced;
        }
        return !(await sup.liveness(svc, st)).running;
      }, { timeoutMs: restartSelfWaitMs, intervalMs: 1000 });
      if (replaced) {
        info(`${caller} 已经换成了新进程（${oldPid} → ${linkOf(caller)?.pid}），重启已经发生`);
        audit('link-manage-restart-self', { caller, phase: 'started', ok: true, by: 'already-restarted' });
        return;
      }
      if (!down) {
        // 等不到空闲：两边都撤（服务那边的挂起也撤），服务照常跑
        const c = linkOf(caller)?.connected ? await sup.link.cancel(caller) : { ok: false, why: '它现在没接入，撤不到它那边' };
        warn(`${caller} 等空闲后重启自己：等了 ${Math.round(restartSelfWaitMs / 60000)} 分钟还在忙，撤销这次重启（它照常跑）`, { cancel: c });
        audit('link-manage-restart-self', { caller, phase: 'gave-up', ok: false, cancelled: !!c?.ok });
        return;
      }
      // 进程和端口都亲眼看过没了：账本照实记成已停（desired 仍是 running）。不记的话 start 先跑的那一轮探活
      // 会给「上一轮还在跑」的服务一轮宽限（DOWN_CONFIRM_PROBES），账本上还是 RUNNING，start 就当它「已经在跑」直接返回
      Object.assign(st, { state: 'STOPPED', pid: null, pidStart: null, runningSince: null, failStreak: 0, pendingStop: false });
      sup.persist();
      const r = await sup.start(caller, { reason });
      audit('link-manage-restart-self', { caller, phase: 'started', ok: !!r.ok, why: r.ok ? null : r.why });
      if (r.ok) info(`${caller} 已按它自己的请求重启`);
      else warn(`${caller} 退出了，但没拉起来：${r.why}`);
    } catch (e) {
      warn(`${caller} 等空闲后重启自己出错：${e?.message || e}`);
      audit('link-manage-restart-self', { caller, phase: 'error', ok: false, why: String(e?.message || e) });
    } finally {
      restarting.delete(caller);
    }
  }

  function restartSelf(caller, msg) {
    const mode = msg.mode ?? 'when-idle';
    if (mode !== 'when-idle') {
      return fail('protected', `重启自己只能等空闲（mode: "when-idle"），不能立刻重启——${caller} 正忙着的事会断在半截`, [{ id: caller, why: ['调用方自己'] }]);
    }
    if (restarting.has(caller)) return { ok: true, queued: true, already: true, note: '已经排着一次了：空闲后重启' };
    const link = linkOf(caller);
    if (!link?.connected) return fail('not-linked', `${caller} 现在没接入，管理器没法等它空闲`);
    if (!(link.capabilities || []).includes('restart')) {
      return fail('no-capability', `${caller} 接入时没报 restart 能力，管理器没法让它等空闲后自己退出`);
    }
    restarting.add(caller);
    return {
      ok: true, queued: true,
      note: '已排队：你空闲了（不再忙）会收到重启指令、自己退出，管理器确认进程退干净后再把你拉起来。现在不用等它',
      // 回复发出去之后才开始：重启指令要排在回复后面，不然不忙的调用方收到指令就退了，回复可能落空
      after: () => { restartSelfFlow(caller); },
    };
  }

  async function handle(caller, msg) {
    const self = sup.services.get(caller);
    if (!self) return fail('not-allowed', `${caller} 不在注册表里`);
    if (self.owner) return fail('not-allowed', `${caller} 是 ${self.owner} 名下的服务，不能用管理指令——名下只有一层`);
    if (NOT_OPEN[msg.type]) return fail('not-allowed', `${NOT_OPEN[msg.type]}不在接入层上开放，要你在服务管家的网页或命令行上做`);
    if (msg.type.startsWith('manage.vps')) return fail('not-allowed', 'VPS 的操作不在接入层上开放，要你在服务管家的网页或命令行上做');
    const reason = `${caller} 经接入层管理`;

    switch (msg.type) {
      case 'manage.list': {
        const lifeline = lifelineOf(sup, caller);
        return {
          ok: true, self: caller,
          services: [...sup.services.values()].map((s) => viewOf(s, lifeline)),
          profiles: Object.fromEntries([...new Set([
            ...Object.keys(sup.manager?.profiles || {}),
            ...[...sup.services.values()].flatMap((s) => s.profiles || []),
          ])].map((n) => [n, sup.profileMembers(n)])),
          lifeline: [...lifeline].map(([id, why]) => ({ id, why })),
          // tailnet 网关是哪个服务（manager.yaml 的 tailnet.gateway，开了 tailnet 才有）：调用方认「它离不开的」要用
          tailnetGateway: (sup.manager?.tailnet?.domain && sup.manager.tailnet.gateway) || null,
        };
      }
      case 'manage.logs': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        const lines = msg.lines == null ? LOG_LINES_DEFAULT : msg.lines;
        if (!Number.isInteger(lines) || lines < 1) return fail('bad-request', `lines 要是正整数（最多 ${LOG_LINES_MAX}）`);
        const sources = logEntries(sup, t.svc);
        const i = msg.source ?? 0;
        if (!Number.isInteger(i) || !sources[i]) return fail('not-found', `${t.id} 没有第 ${i} 份日志（有 ${sources.length} 份）`);
        const n = Math.min(lines, LOG_LINES_MAX);
        // 多要一行：文件以换行结尾时 tail 的最后一「行」是空的，不能让它占掉一个名额
        const r = tail(sources[i].file, { lines: n + 1, maxBytes: LOG_MAX_BYTES });
        if (!r.ok) return fail('not-found', r.why);
        const got = r.lines.split(/\r?\n/);
        if (got.at(-1) === '') got.pop();
        return {
          ok: true, name: t.id, source: i, label: sources[i].label, lines: got.slice(-n).join('\n'),
          capped: lines > LOG_LINES_MAX, sources: sources.map((s, k) => ({ source: k, label: s.label })),
        };
      }
      case 'manage.start': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        return serial(t.id, async () => result(caller, t.id, await sup.start(t.id, { reason })));
      }
      case 'manage.stop': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        const mode = msg.mode ?? 'now';
        if (!['now', 'when-idle'].includes(mode)) return fail('bad-request', 'mode 只能是 now 或 when-idle');
        const force = msg.force === true;
        const no = guard(caller, [t.id], `${force ? '强制' : ''}停止 ${t.id}`);
        if (no) return no;
        return serial(t.id, async () => {
          const r = await sup.stop(t.id, { mode, force, reason });
          if (r.code === 'no-capability') return result(caller, t.id, { ...r, why: `${r.why}。要停就带 force: true` });
          return result(caller, t.id, r);
        });
      }
      case 'manage.restart': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        if (msg.mode != null && msg.mode !== 'now') return fail('bad-request', '这里的重启都是立刻重启；等空闲再重启只有 restartSelf（重启调用方自己）');
        const no = guard(caller, [t.id], `重启 ${t.id}`);
        if (no) return no;
        return serial(t.id, async () => result(caller, t.id, await restartNow(caller, t.svc, msg.force === true)));
      }
      case 'manage.cancelStop': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        return serial(t.id, async () => result(caller, t.id, await sup.cancelPendingStop(t.id)));
      }
      case 'manage.autostart': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        if (typeof msg.on !== 'boolean') return fail('bad-request', 'manage.autostart 要带 on: true / false');
        if (!msg.on) {
          const no = guard(caller, [t.id], `把 ${t.id} 移出开机自启`);
          if (no) return no;
        }
        return serial(t.id, async () => {
          const a = sup.setAutostart(t.id, msg.on);
          if (!a.ok) return result(caller, t.id, { ok: false, code: 'registry', why: a.why });
          sup.emit?.('registry-changed');
          return result(caller, t.id, { ok: true });
        });
      }
      case 'manage.profileStart':
      case 'manage.profileStop': {
        const bad = need(msg, 'profile', '场景名');
        if (bad) return bad;
        const members = sup.profileMembers(msg.profile);
        if (!members.length) return fail('not-found', `没有这个场景：${msg.profile}`);
        const stop = msg.type === 'manage.profileStop';
        if (stop) {
          // 场景停止会连它们依赖的一起停（supervisor.stopProfile 按拓扑层停），按真正会停的那些查
          const touched = topoLayers(sup.services, members).flat();
          const no = guard(caller, touched, `停止场景 ${msg.profile}`);
          if (no) return no;
        }
        return serial(`profile:${msg.profile}`, async () => {
          const r = stop ? await sup.stopProfile(msg.profile, { force: msg.force === true }) : await sup.startProfile(msg.profile);
          const results = (r.results || []).map((x) => ({
            id: x.id, ok: !!x.ok, ...(x.already ? { already: true } : {}), ...(x.pending ? { pending: true } : {}), ...(x.ok ? {} : { why: x.why || '失败' }),
          }));
          return r.ok ? { ok: true, profile: msg.profile, results }
            : { ...fail('failed', r.why || `场景 ${msg.profile} 里有服务没${stop ? '停' : '起'}成：${results.filter((x) => !x.ok).map((x) => `${x.id}（${x.why}）`).join('；')}`), profile: msg.profile, results };
        });
      }
      case 'manage.exposeOn':
      case 'manage.exposeOff': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        const via = t.svc.exposure?.via;
        if (!via || !sup.services.has(via)) return fail('not-found', `${t.id} 没有公网入口（注册表里没写 exposure.via）`);
        // 公网入口没有独立的生命周期，它就是那条隧道服务：开 = 起隧道，关 = 强制停隧道（和 WebUI 一样）
        if (msg.type === 'manage.exposeOn') return serial(via, async () => ({ ...result(caller, t.id, await sup.start(via, { reason })), tunnel: via }));
        const no = guard(caller, [t.id, via], `关掉 ${t.id} 的公网入口（强制停隧道 ${via}）`);
        if (no) return no;
        return serial(via, async () => ({ ...result(caller, t.id, await sup.stop(via, { force: true, reason })), tunnel: via }));
      }
      case 'manage.tailnetOpen': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        if (msg.tailnetName != null && (typeof msg.tailnetName !== 'string' || !msg.tailnetName)) return fail('bad-request', 'tailnetName 要是字符串（域名的第一段），不给就按服务名');
        return serial(`tailnet:${t.id}`, async () => result(caller, t.id, await sup.openTailnet(t.id, { name: msg.tailnetName })));
      }
      case 'manage.tailnetClose': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        if (!sup.tailnetEntries?.has(t.id)) return fail('not-found', `${t.id} 没有 tailnet 入口`);
        const ids = [t.id];
        // 撤的是最后一个入口时，管理器会顺手强制停掉网关——网关是命脉的话也不行
        const gw = sup.manager?.tailnet?.gateway;
        if (gw && sup.tailnetEntries.size === 1) ids.push(gw);
        const no = guard(caller, ids, `撤掉 ${t.id} 的 tailnet 入口`);
        if (no) return no;
        return serial(`tailnet:${t.id}`, async () => result(caller, t.id, await sup.closeTailnet(t.id)));
      }
      case 'manage.remove': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        const no = guard(caller, [t.id], `撤销 ${t.id}`);
        if (no) return no;
        if (!sup.owned) return fail('failed', '管理器没有挂上名下服务的模块');
        // 和你在 WebUI 上点「撤销」、登记方发 services.remove 走同一条路（先强制停，再拿掉登记）
        const r = await sup.owned.withdraw(t.id, { by: caller });
        return r.ok ? { ok: true, removed: r.removed } : r;
      }
      case 'manage.orphan': {
        const t = targetOf(msg);
        if (!t.ok) return t;
        if (!['adopt', 'kill'].includes(msg.decision)) return fail('bad-request', 'manage.orphan 要带 decision: "adopt"（认领）或 "kill"（杀掉占着端口的进程）');
        if (msg.decision === 'kill') {
          const no = guard(caller, [t.id], `杀掉占着 ${t.id} 端口的进程`);
          if (no) return no;
        }
        return serial(t.id, async () => result(caller, t.id, await sup.resolveOrphan(t.id, msg.decision)));
      }
      case 'manage.restartSelf':
        return restartSelf(caller, msg);
      default:
        return fail('bad-request', `不认识的消息：${msg.type}`);
    }
  }

  /**
   * 协议入口：一条 manage.* 请求 → 回复（内部格式，线上格式见 owned.mjs 的 wireReply）。
   * 回复里可能带 after()：回复发出去之后再调（restartSelf 用它在回复之后才开始重启）。
   */
  async function request(caller, msg) {
    let r;
    try { r = await handle(caller, msg); } catch (e) { r = fail('failed', String(e?.message || e)); }
    audit('link-manage', {
      caller, type: msg.type,
      target: msg.name ?? msg.profile ?? null,
      ...(msg.mode != null ? { mode: msg.mode } : {}), ...(msg.force != null ? { force: msg.force } : {}),
      ...(msg.on != null ? { on: msg.on } : {}), ...(msg.decision != null ? { decision: msg.decision } : {}),
      ok: !!r.ok, ...(r.ok ? {} : { code: r.code, why: r.why }), ...(r.queued ? { queued: true } : {}),
    });
    return r;
  }

  return { request, lifelineOf: (caller) => lifelineOf(sup, caller), viewOf };
}
