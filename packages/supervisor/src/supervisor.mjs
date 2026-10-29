// 状态机与编排。这里是账本与现实对账的地方——现实永远赢——服务是脱离管理器的独立进程，账本只是线索。
import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { loadManager, loadServices, topoLayers } from './registry.mjs';
import { LOGS_DIR, SERVICES_DIR } from './paths.mjs';
import * as store from './state.mjs';
import { probeService, snapshot } from './probe.mjs';
import { runHook, spawnDetached } from './hooks.mjs';
import { allProcesses, findServiceTreeTop, killTree, lanIp, sessionEpoch, unregisterScheduledTask, waitFor, sleep } from './winproc.mjs';
import { exposureOf, exposureCreatable, exposedPort } from './exposure.mjs';
import { loadBootList, saveBootList, autostartBlocked, bootPlan } from './bootlist.mjs';
import * as tn from './tailnet.mjs';
import * as vb from './vpsbilling.mjs';
import { toast } from './notify.mjs';
import { createOwned } from './owned.mjs';
import { info, warn, audit } from './log.mjs';

export const STATES = ['STOPPED', 'STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'FAILED', 'ORPHAN', 'EXTERNAL'];

/** 从"在跑"掉下来需要连续失败几轮才认。1 轮太敏感，3 轮就太迟钝了。 */
export const DOWN_CONFIRM_PROBES = 2;

/**
 * 探活失败一次，够不够判定服务已经挂了？
 *
 * 不够——只要它**上一轮还在跑**。健康检查只给 3 秒，机器一忙（比如 GPU 推理服务一吃显存就很忙）
 * 就可能超时，而「在跑的服务被报成挂了」比「晚 5 秒发现真挂了」有害得多：
 * 前者让人以为服务关了，还会触发 autoRestart 去重拉一个活得好好的进程
 * （实测：一个服务就这样被误判过，它的隧道更是对着活着的 ssh 空转了 11 回）。
 *
 * 反过来，本来就不在跑的（STOPPED/FAILED/STARTING）不给宽限——它们没有「正在提供服务」
 * 这个需要保护的事实，多等一轮只会推迟真相。
 */
export function confirmsDown({ before, desired, failStreak }) {
  const wasUp = before === 'RUNNING' || before === 'DEGRADED';
  if (!wasUp || desired !== 'running') return true;
  return failStreak >= DOWN_CONFIRM_PROBES;
}

/**
 * 服务**还在不在跑**：只看进程和端口，不看健康检查（2026-10-18 修）。
 *
 * 原来停机、探活里的 STOPPING 判定都用「探活不过」当「已经停了」。health 档的服务健康检查一不过
 * （起来了但 /health 回 500、或者正忙得超时），stop 就当场报「已停止」——进程其实还活着、端口还在听，
 * 而账本记成 STOPPED、PID 清掉，从此没人管它。「健康不健康」和「还在不在」是两件事。
 *
 * 证据（任何一条成立就算还在跑），pids 是兜底强杀时要收拾的进程：
 *  - 接入层连接还在（连接在 = 进程在）；
 *  - 有端口的：端口上有人在听（端口是身份，谁在听谁就是它）；
 *  - 没端口的（process 档）：probe 按 PID 文件 / 账本 / matchCmd 核过身份后找到了进程；
 *  - 账本里的 PID 还活着——启动时间对得上才算；还没记下启动时间时（刚 spawn 完、只拿到 cmd 包装层），
 *    命令行里得有这个服务自己的日志路径（cmd 的 `>> logs/<id>.out.log`）才算。光凭 PID 存在就认，
 *    PID 被复用后兜底强杀会杀错人（Windows 回收 PID 很快）。
 */
export function runningEvidence(svc, st, snap, { probe = null, link = null, outLog = null } = {}) {
  const pids = new Set();
  const why = [];
  if (link?.connected) {
    why.push('接入层连接还在');
    if (link.pid) pids.add(link.pid);
  }
  const port = svc.probe?.port;
  if (port) {
    const ls = snap?.ports?.get(port) || [];
    if (ls.length) { ls.forEach((p) => pids.add(p)); why.push(`端口 ${port} 还有人在听（PID ${ls.join('、')}）`); }
  } else if (probe?.ok) {
    if (probe.pid) pids.add(probe.pid);
    why.push(probe.detail || '进程还在');
  }
  if (st?.pid && !pids.has(st.pid)) {
    const info = snap?.procs?.get(st.pid);
    const same = info && (st.pidStart
      ? (!info.start || info.start === st.pidStart)
      : !!outLog && (info.cmd || '').toLowerCase().includes(outLog.toLowerCase()));
    if (same) { pids.add(st.pid); why.push(`进程 ${info.name || '?'} (${st.pid}) 还在`); }
  }
  return { running: why.length > 0, pids: [...pids], why: why.join('；') };
}

/** 强制停止时给服务自己收尾的时间；过了就杀进程树。 */
export const FORCE_GRACE_MS = 10000;

/**
 * 这次停机怎么停：用哪种 mode、最多等多久就杀进程树。
 *
 * 强制停止（卡片上的「强制停止」/ `lsm stop --force`）是你明确要它现在就停：
 *  - 不管 when-idle，一律按 now 发——忙着的服务原来只能排队等空闲，长任务一跑几小时就停不下来（2026-10-13 实测踩到）；
 *  - 先给它 FORCE_GRACE_MS 自己收尾（钩子配的超时更短就用更短的），过了就杀；
 *  - 什么停机手段都没有：直接杀，没必要干等。
 * 不强制时：when-idle 忙多久等多久（管理器自己绝不强杀它），now 按钩子的超时。
 */
export function stopPlan({ mode = 'now', force = false, linked = false, hookStop = null }) {
  if (force) {
    if (!linked && !hookStop) return { mode: 'now', deadlineMs: 0 };
    return { mode: 'now', deadlineMs: Math.min(hookStop?.timeoutMs ?? FORCE_GRACE_MS, FORCE_GRACE_MS) };
  }
  if (mode === 'when-idle') return { mode, deadlineMs: hookStop?.idleTimeoutMs ?? 3600000 };
  return { mode, deadlineMs: hookStop?.timeoutMs ?? 60000 };
}

export class Supervisor extends EventEmitter {
  constructor() {
    super();
    this.link = null;            // M7 接入层挂上来（可选）
    this.state = store.load();
    // 正在退避等待重启的服务。**必须放在 Supervisor 上，不能放进 st**——
    // st 是会被 persist() 写进 state.json 的那个对象，标志一旦落盘、
    // 又赶上管理器在退避中途死掉，finally 跑不到，重启后读回 true 就永久卡死。
    // 2026-09-03 实测：六条隧道的 autoRestart 就是这么全部失效的。
    this.autoRestarting = new Set();
    this.starting = new Map();   // id → 正在进行的那次 start() 的 Promise（见 start 的注释）
    // 开机那一下正在决定「上次留下的服务还算不算数」，这期间不许 autoRestart 抢先把它们拉起来
    this.booting = false;
    // 接入的项目经协议登记、启停、撤销的「名下的服务」（docs/link-protocol.md §7）。CLI 本地直连模式也要用它撤销，所以挂在这里
    this.owned = createOwned(this);
    this.reload();
  }

  reload() {
    this.manager = loadManager();
    const { services, errors } = loadServices();
    this.services = services;
    const boot = loadBootList();
    this.bootList = boot.ids;
    this.bootListError = boot.error;
    if (boot.error) errors.push(boot.error);
    for (const id of boot.ids) if (!services.has(id)) errors.push(`autostart.yaml: 开机自启列表里的 "${id}" 不存在`);
    const tl = tn.loadTailnetList();
    this.tailnetEntries = tl.entries;
    this.tailnetListError = tl.error;
    if (tl.error) errors.push(tl.error);
    errors.push(...tn.tailnetListErrors(tl.entries, services, this.manager.tailnet));
    // 清单是本机这一半的唯一来源：每次 reload 都按它重写网关的路由表（手改 tailnet.yaml 后 lsm reload 即生效）
    if (!tl.error) { try { this.writeTailnetRoutes(); } catch (e) { errors.push(`tailnet 路由表写不了：${e.message}`); } }
    if (this.manager.vps?.key && !fs.existsSync(this.manager.vps.key)) {
      errors.push(`manager.yaml: vps.key 指向的密钥文件不存在：${JSON.stringify(this.manager.vps.key)}（「开通公网」会被拒绝）`);
    }
    // 凭证文件还没放不算错（那是「还没配」，Tailnet 栏下面的 VPS 费用栏会教你怎么配）；配置本身写错了才算
    const bcfg = vb.billingConfig(this.manager);
    if (bcfg && !['cn', 'intl'].includes(bcfg.site)) errors.push(`manager.yaml: vps.billing.site 只能是 cn 或 intl，现在是 ${JSON.stringify(bcfg.site)}`);
    this.registryErrors = errors;
    for (const e of errors) warn(`注册表校验：${e}`);
    return errors;
  }

  get(id) {
    const svc = this.services.get(id);
    if (!svc) throw new Error(`没有这个服务：${id}`);
    return svc;
  }

  st(id) { return store.serviceState(this.state, id); }

  /** 这个服务的命令行输出落在哪：管理器 spawn 的输出、各个钩子的输出都写这里，日志页读的就是它。 */
  outLog(id) { return path.join(LOGS_DIR, `${id}.out.log`); }

  persist() { store.save(this.state); }

  linkStatus = (id) => this.link?.status(id) ?? null;

  /** 用这一轮已有的快照和探活结果判断还在不在跑（refresh 里用，不多起 PowerShell）。 */
  evidence(svc, st, snap, probe) {
    return runningEvidence(svc, st, snap, { probe, link: this.linkStatus(svc.id), outLog: this.outLog(svc.id) });
  }

  /** 现在去看一眼：这个服务还在不在跑（只看进程和端口，见 runningEvidence）。 */
  async liveness(svc, st = this.st(svc.id), snap = null) {
    snap ||= await snapshot([svc]);
    // 没端口的只能靠 probe 认进程（它会核 PID 文件 / matchCmd）；有端口的端口就够了，不去打健康检查
    const probe = svc.probe.port ? null : await probeService(svc, st, snap, this.linkStatus);
    return runningEvidence(svc, st, snap, { probe, link: this.linkStatus(svc.id), outLog: this.outLog(svc.id) });
  }

  /** 一轮全量探活。现实与账本不一致时以现实为准。 */
  async refresh() {
    const list = [...this.services.values()];
    if (!list.length) return [];
    const snap = await snapshot(list);
    const changes = [];
    const orphans = [];

    for (const svc of list) {
      const st = this.st(svc.id);
      const before = st.state;
      const p = await probeService(svc, st, snap, this.linkStatus);

      st.tier = p.tier;
      st.detail = p.detail;
      st.busy = p.busy ?? false;
      st.busyReason = p.busyReason ?? null;
      st.degradedObservation = !!p.degradedObservation;
      // 端口有没有人听、健康检查的结论：名下的服务的状态推送要分开给
      st.listening = p.listening ?? null;
      st.health = p.health ?? null;
      if (p.bindAddrs) st.bindAddrs = p.bindAddrs;
      st.lastProbeAt = Date.now();

      if (svc.kind === 'external') {
        st.state = 'EXTERNAL';
        st.up = p.ok;
      } else if (st.state === 'STOPPING') {
        // 停没停看进程和端口，不看探活过不过：健康检查不过的服务进程还在、端口还在听（2026-10-18 修）
        if (!this.evidence(svc, st, snap, p).running) { st.state = 'STOPPED'; st.pid = null; st.pidStart = null; }
      } else if (p.ok) {
        st.failStreak = 0;      // 探活成功即清零，宽限只对**连续**失败生效
        if (p.orphan && st.desired !== 'running') {
          st.state = 'ORPHAN';
          st.orphanWhy = p.orphanWhy;
        } else {
          // 认领：把现实里的 PID/启动时间写回账本
          st.pid = p.pid ?? st.pid;
          st.pidStart = p.pidStart ?? st.pidStart;
          st.port = svc.probe.port ?? null;
          st.state = st.degradedObservation ? 'DEGRADED' : 'RUNNING';
          st.orphanWhy = null;
          if (!st.runningSince) st.runningSince = Date.now();
        }
      } else if (st.state === 'STARTING') {
        if (Date.now() > (st.readyDeadline || 0)) {
          st.state = 'FAILED';
          st.lastError = '启动后未在 readyTimeout 内转为就绪';
        }
      } else if (st.pendingStop && !this.evidence(svc, st, snap, p).running) {
        // 排队中的 when-idle 停机终于完成了——这是成功，不是故障。
        // 「完成」= 进程和端口都没了；只是健康检查不过、进程还在，那不叫停了，走下面的故障判定
        st.pid = null; st.pidStart = null; st.runningSince = null;
        st.pendingStop = false; st.desired = 'stopped'; st.state = 'STOPPED';
        info(`${svc.id} 等到空闲，已按排队的请求自行停止`);
      } else {
        // 封顶在阈值上：再往上数没有任何意义，判定只看「够不够 DOWN_CONFIRM_PROBES」。
        // 不封顶的话它会一直涨（实测见过 77745），把账本和排查视野都污染掉。
        st.failStreak = Math.min((st.failStreak || 0) + 1, DOWN_CONFIRM_PROBES);
        if (confirmsDown({ before, desired: st.desired, failStreak: st.failStreak })) {
          st.pid = null; st.pidStart = null; st.runningSince = null;
          st.state = st.desired === 'running' ? 'FAILED' : 'STOPPED';
        } else {
          // 宽限一轮：状态和 PID 都不动，只在 detail 里说明正在确认
          st.detail = `${p.detail}（第 ${st.failStreak} 次，下一轮再确认）`;
        }
      }

      if (st.state !== before) {
        changes.push({ id: svc.id, from: before, to: st.state });
        info(`状态变更 ${svc.id}: ${before} → ${st.state}`, { detail: st.detail });
        if (st.state === 'ORPHAN') orphans.push(svc);
      }

      // autoRestart 必须按**状态**判，不能按**跳变**判（2026-09-02 实测踩到）。
      //
      // 原来这行在上面的 `if (st.state !== before)` 里，只在「刚掉进 FAILED」那一瞬间触发。
      // 后果：管理器一重启，它直接 spawn 的隧道跟着它一起死（2026-08-29 实测，
      // 后来查明是共用控制台和 libuv 的 job 两件事，见 hooks.spawnDetached），新管理器从 state.json 读到它们**本来就是 FAILED**，
      // 第一轮探活得到 FAILED → FAILED——**没有跳变，于是永远不会重试**。
      // 六条隧道就这么一起哑掉，日志里连一次重试记录都没有，公网全线 502。
      //
      // 「desired=running 但它没在跑」是一个持续成立的**条件**，不是一个瞬间发生的**事件**，
      // 所以每轮都要重新评估。重试上限和退避仍然由 maybeAutoRestart 自己把关。
      if (st.state === 'FAILED') this.maybeAutoRestart(svc).catch(() => {});
    }

    // 已纳管的服务出现冲突 → 直接把占着它端口的入侵者杀掉（用户 2026-08-23 的决定，
    // 覆盖了原来的「孤儿一律请你裁决」）。理由：这个端口本来就是这个服务的，
    // 账本里有它的 PID 而现在换了人，说明有第二个东西在管它 —— 那正是要消灭的状态。
    // 反过来，**没纳管**的东西一律只通知不动手（哨兵的职责边界：只让你看见，不替你动手）。
    for (const svc of orphans) {
      if (this.manager.autoResolveConflicts === false) continue;
      const st = this.st(svc.id);
      warn(`${svc.id} 端口被别的进程占了（${st.orphanWhy}）——已纳管服务的冲突，直接清掉入侵者`);
      audit('auto-resolve-conflict', { id: svc.id, why: st.orphanWhy, pid: st.pid });
      try {
        const snap2 = await snapshot([svc]);
        for (const pid of snap2.ports.get(svc.probe.port) || []) await this.killServiceTree(svc, pid);
        st.state = 'STOPPED'; st.pid = null; st.pidStart = null; st.orphanWhy = null;
        if (st.desired === 'running') await this.start(svc.id, { reason: '冲突清理后重新拉起' });
      } catch (e) { warn(`${svc.id} 冲突清理失败：${e.message}`); }
    }
    this.persist();
    this.emit('refresh', this.snapshotForUi());
    for (const c of changes) this.emit('change', c);
    return changes;
  }

  /**
   * 管理器起来后的第一件事：重认领，把上次留下的服务认回来，而不是重启它们（管理器天天改、天天重启，不能每次都把服务带走）。
   *
   * 但先要分清这是哪种「起来」：
   *  - 管理器自己重启（看门狗、改代码）：上次的「该在跑」照样算数，autoRestart 照常把掉了的拉回来。
   *  - 新的登录会话（开机、注销再登录）：上一个会话里的服务早随关机死光了，
   *    账本里的「该在跑」一律作废，**只**拉起开机自启列表里的。
   *    原来没有这一步，于是开着 autoRestart 的服务（常驻服务、隧道……）开机后都会被当成
   *    「挂掉了」重拉——那是个副作用，不是谁选的。
   */
  async adopt() {
    this.booting = true;
    let plan = { fresh: false, start: [] };
    try {
      const epoch = await sessionEpoch();
      const prevEpoch = this.state.manager?.sessionEpoch ?? null;
      plan = bootPlan({ prevEpoch, epoch, bootList: this.bootList, services: this.services });
      if (epoch) this.state.manager = { ...this.state.manager, sessionEpoch: epoch };
      else warn('读不到本次登录会话的建立时间——按「管理器自己重启」处理，这次不做开机自启');
      if (plan.fresh) this.forgetLastSession();
      this.persist();
    } finally {
      this.booting = false;
    }

    const changes = await this.refresh();
    const adopted = [...this.services.values()].filter((s) => this.st(s.id).state === 'RUNNING').map((s) => s.id);
    const orphans = [...this.services.values()].filter((s) => this.st(s.id).state === 'ORPHAN').map((s) => s.id);
    info(`重认领完成：${adopted.length} 个服务在跑${orphans.length ? `，${orphans.length} 个孤儿待裁决` : ''}`);
    const boot = plan.fresh ? await this.startBootList(plan.start) : null;
    return { adopted, orphans, changes, boot };
  }

  /** 新的登录会话：上一个会话起的服务都随关机/注销死了，账本里关于它们的一切不再算数。 */
  forgetLastSession() {
    for (const svc of this.services.values()) {
      if (svc.kind === 'external') continue;
      // pid 一并清掉：留着旧 PID，碰巧还活着的同端口进程会被判成「孤儿」，进而被冲突清理杀掉
      Object.assign(this.st(svc.id), {
        state: 'STOPPED', desired: 'stopped', pid: null, pidStart: null, runningSince: null,
        failStreak: 0, retries: 0, pendingStop: false, lastError: null, orphanWhy: null,
      });
    }
    info('新的登录会话：上次留下的服务状态全部作废，只按开机自启列表拉起');
  }

  /** 按依赖分层拉起开机自启列表。起不来的照常进 FAILED，开着 autoRestart 的（隧道）会自己重试——开机时网络常常还没好。 */
  async startBootList(ids) {
    if (!ids.length) {
      info('开机自启列表是空的——这次开机只有管理器自己');
      return { ok: true, results: [] };
    }
    info(`开机自启：${ids.join('、')}`);
    audit('boot-autostart', { ids });
    const results = [];
    for (const layer of topoLayers(this.services, ids)) {
      const rs = await Promise.all(layer.map((id) => this.start(id, { reason: '开机自启' })
        .catch((e) => ({ ok: false, why: String(e?.message || e) }))));
      layer.forEach((id, i) => results.push({ id, ...rs[i] }));
    }
    for (const r of results) if (!r.ok) warn(`开机自启 ${r.id} 没起来：${r.why}`);
    return { ok: results.every((r) => r.ok), results };
  }

  /** WebUI 卡片上的「开机自启」开关。 */
  setAutostart(id, on) {
    const svc = this.get(id);
    if (this.bootListError) return { ok: false, why: `${this.bootListError}——先把这个文件修好，免得把你手改的内容覆盖掉` };
    if (on) {
      const why = autostartBlocked(svc);
      if (why) return { ok: false, why };
      this.bootList.add(id);
    } else {
      this.bootList.delete(id);
    }
    saveBootList(this.bootList);
    audit('autostart', { id, on: !!on });
    info(`开机自启${on ? '加入' : '移出'}：${id}`, { list: [...this.bootList] });
    return { ok: true, autostart: !!on, bootList: [...this.bootList].sort() };
  }

  /** 默认不自动重启；只有显式开启的服务（隧道这类）才走这里（吃显存的服务盲目重拉代价太大；隧道这类断了就该重连、重连零代价）。 */
  async maybeAutoRestart(svc) {
    const ar = svc.autoRestart;
    if (!ar?.enabled) return;
    if (this.booting) return;
    const st = this.st(svc.id);
    if (st.desired !== 'running') return;

    // 防重入：本函数按状态被每轮调用（见 refresh 里的注释），而它中间要 await 一段退避。
    // 没有这道闸，5 秒一轮的探活会把重试排队叠起来，几十秒就把 maxRetries 烧穿，
    // 退避也就形同虚设。
    // 闸放在 this.autoRestarting（Supervisor 实例上）而不是 st 里：st 会被落盘，
    // 落盘的闸在管理器中途死掉后会永久卡住——构造函数那里有完整教训。
    if (this.autoRestarting.has(svc.id)) return;
    this.autoRestarting.add(svc.id);
    try {
      st.retries = (st.retries || 0) + 1;
      if (st.retries > (ar.maxRetries ?? 5)) {
        warn(`${svc.id} 自动重启次数用尽（${ar.maxRetries}），停手等你介入`);
        return;
      }
      const backoff = ar.backoffMs?.[Math.min(st.retries - 1, (ar.backoffMs.length || 1) - 1)] ?? 15000;
      info(`${svc.id} 将在 ${backoff}ms 后自动重启（第 ${st.retries} 次）`);
      await sleep(backoff);
      if (this.st(svc.id).state === 'FAILED') await this.start(svc.id, { reason: 'auto-restart' });
    } finally {
      this.autoRestarting.delete(svc.id);
    }
  }

  linkEnv(svc) {
    if (!svc.link?.enabled) return {};
    const st = this.st(svc.id);
    st.linkToken = crypto.randomBytes(24).toString('hex');   // 一次性令牌，有效期 = 本次实例生命周期
    return {
      LSM_URL: `ws://${this.manager.bind}:${this.manager.port}/link`,
      LSM_SERVICE_ID: svc.id,
      LSM_TOKEN: st.linkToken,
      LSM_PROTOCOL: '1',
    };
  }

  async ensureDeps(svc, trail = new Set()) {
    for (const dep of svc.dependsOn) {
      if (trail.has(dep.id)) continue;
      trail.add(dep.id);
      const depSvc = this.services.get(dep.id);
      if (!depSvc) continue;
      const dst = this.st(dep.id);

      if (depSvc.kind === 'external') {
        if (!dst.up) {
          if (dep.type === 'hard') return { ok: false, why: `硬依赖 ${dep.id} 是外部服务且不在跑，管理器无权启动它` };
          warn(`${svc.id} 的软依赖 ${dep.id}（外部服务）不在跑，降级启动`);
        }
        continue;
      }
      if (dst.state === 'RUNNING' || dst.state === 'DEGRADED') continue;

      const r = await this.start(dep.id, { reason: `${svc.id} 的${dep.type === 'hard' ? '硬' : '软'}依赖`, trail });
      if (!r.ok && dep.type === 'hard') return { ok: false, why: `硬依赖 ${dep.id} 起不来：${r.why}` };
      if (!r.ok) warn(`${svc.id} 的软依赖 ${dep.id} 起不来，降级启动：${r.why}`);
    }
    return { ok: true };
  }

  /**
   * 同一个服务同一时刻只允许一次启动：并发的调用共享同一个结果。
   *
   * 2026-10-08 实测：autoRestart 刚把一个服务拉到 STARTING，依赖它的服务的软依赖编排
   * 看它「还没 RUNNING」就又起了一次——审计日志里 hub 隔 4 秒被 start 了两回（09-29 起一直如此）。
   * 以前第二次会真的再 spawn 一份（端口冲突后自己死掉，或者更糟，两份都活着）；
   * 现在第二次会撞上第一份的 cmd 正占着日志文件写，报 EBUSY 失败——都不对，该等第一次的结果。
   */
  start(id, opts = {}) {
    const inflight = this.starting.get(id);
    if (inflight) return inflight;
    const p = this.startOnce(id, opts).finally(() => this.starting.delete(id));
    this.starting.set(id, p);
    return p;
  }

  async startOnce(id, { reason = 'manual', trail = new Set() } = {}) {
    const svc = this.get(id);
    const st = this.st(id);
    if (svc.kind === 'external') return { ok: false, why: `${id} 是外部服务，管理器只探活不负责生死` };
    if (!svc.capabilities.includes('start')) return { ok: false, why: `${id} 没有 start 能力` };

    await this.refresh();
    if (['RUNNING', 'DEGRADED'].includes(st.state)) return { ok: true, already: true };
    if (st.state === 'ORPHAN') return { ok: false, why: `端口被不认识的进程占着（${st.orphanWhy}），请先裁决孤儿` };

    const deps = await this.ensureDeps(svc, trail);
    if (!deps.ok) return { ok: false, why: deps.why };

    // 端口冲突只报不改（管理器不分配端口，只让冲突可见）
    if (svc.probe.port) {
      const snap = await snapshot([svc]);
      const owners = snap.ports.get(svc.probe.port) || [];
      if (owners.length) {
        const p = snap.procs.get(owners[0]);
        return { ok: false, why: `端口 ${svc.probe.port} 已被 ${p?.name || '未知进程'} (${owners[0]}) 占着` };
      }
    }

    st.desired = 'running';
    st.state = 'STARTING';
    st.lastError = null;
    st.readyDeadline = Date.now() + (svc.hooks.start.readyTimeoutMs ?? 60000);
    this.persist();
    this.emit('change', { id, from: null, to: 'STARTING' });
    audit('start', { id, reason });

    const extraEnv = this.linkEnv(svc);
    const logFile = this.outLog(svc.id);
    st.managerLog = logFile;
    let r;
    if (svc.hooks.start.detaches === false) {
      // 前台常驻脚本：管理器自己 spawn，PID 当场到手，输出也接管了
      r = await spawnDetached(svc, { extraEnv, logFile });
      if (r.ok) st.pid = r.pid;
    } else {
      // 钩子自己 detach：跑完就退，真实 PID 稍后靠端口反查（端口是服务的身份）。钩子本身的输出照样记下来。
      r = await runHook(svc, 'start', { extraEnv, logFile });
    }
    if (!r.ok) {
      st.state = 'FAILED';
      st.lastError = `start 失败（${r.reason}）：${(r.stderr || r.stdout || '').slice(-500)}`;
      this.persist();
      warn(`${id} 启动失败`, { reason: r.reason });
      return { ok: false, why: st.lastError, hook: r };
    }

    // 钩子可能自己 detach（有的项目就是），所以不追它的子孙，等端口/健康转绿
    const ready = await waitFor(async () => {
      const snap = await snapshot([svc]);
      const p = await probeService(svc, st, snap, this.linkStatus);
      return p.ok;
    }, { timeoutMs: svc.hooks.start.readyTimeoutMs ?? 60000, intervalMs: 1000 });

    await this.refresh();
    if (!ready) {
      st.state = 'FAILED';
      st.lastError = 'start 钩子成功返回，但服务未在 readyTimeout 内转为就绪';
      this.persist();
      return { ok: false, why: st.lastError };
    }
    st.retries = 0;
    st.lastStartedAt = Date.now();
    this.persist();
    info(`${id} 已启动`, { pid: st.pid, tier: st.tier });
    return { ok: true, pid: st.pid };
  }

  async stop(id, { mode: askedMode = 'now', force = false, reason = 'manual' } = {}) {
    const svc = this.get(id);
    const st = this.st(id);
    if (svc.kind === 'external') return { ok: false, why: `${id} 是外部服务，管理器不负责它的生死` };

    // 先看它到底还在不在跑——进程和端口说了算，健康检查不算（2026-10-18 修，见 runningEvidence）。
    // 本来就没在跑的：什么停机能力都不需要，直接记成已停。
    const before = await this.liveness(svc, st);
    if (!before.running) {
      const was = st.state;
      Object.assign(st, { desired: 'stopped', state: 'STOPPED', pid: null, pidStart: null, runningSince: null, pendingStop: false });
      this.persist();
      if (was !== 'STOPPED') this.emit('change', { id, from: was, to: 'STOPPED' });
      return { ok: true, already: true };
    }

    const linked = this.link?.status(id)?.connected;
    const canStop = linked ? this.link.status(id).capabilities?.includes('stop') : !!svc.hooks.stop;
    if (!canStop && !force) {
      // 不外挂伪造能力：没有就是没有，WebUI 上灰显
      return { ok: false, code: 'no-capability', why: `${id} 未提供停机能力（它还在跑：${before.why}）。接入统一层后可用；确实要停可以用强制 kill（会丢正在进行的工作）` };
    }

    // when-idle 的语义是「等它空闲，多久都等」，用普通停机超时去卡它、然后强杀，
    // 恰恰毁掉了这个模式存在的理由（2026-08-23 实测踩到）。强制停止是另一回事，见 stopPlan。
    const { mode, deadlineMs } = stopPlan({ mode: askedMode, force, linked, hookStop: svc.hooks.stop });
    if (force && st.pendingStop) info(`${id}：强制停止，覆盖之前排队的「等空闲再停」`);

    st.desired = 'stopped';
    st.state = 'STOPPING';
    this.persist();
    this.emit('change', { id, from: null, to: 'STOPPING' });
    audit('stop', { id, mode, force, reason });

    let hookResult = null;
    if (linked && canStop) {
      hookResult = await this.link.stop(id, { mode, deadlineMs });
      if (mode === 'when-idle' && hookResult?.ok) {
        // 服务已应答「我排队等空闲」。这里**必须立刻返回**：忙多久等多久，
        // 阻塞在这儿会把 HTTP 请求挂住几十分钟（2026-08-23 实测踩到）。
        // 它什么时候真的停，探活循环会看到。
        st.state = 'RUNNING';
        st.desired = 'running';
        st.pendingStop = true;
        this.persist();
        info(`${id} 正忙，停机已排队——它空闲后会自己停（要立刻停就用强制 kill）`);
        return { ok: true, pending: true, why: '服务正忙，停机已排队，等它空闲后自己完成' };
      }
    } else if (svc.hooks.stop) {
      hookResult = await runHook(svc, 'stop', { logFile: this.outLog(id) });
      if (!hookResult.ok && !force) {
        st.state = 'FAILED';
        st.lastError = `stop 钩子失败（${hookResult.reason}）：${(hookResult.stderr || '').slice(-500)}`;
        this.persist();
        return { ok: false, why: st.lastError };
      }
    }

    // 停没停看进程和端口（runningEvidence），不看探活过不过：原来用「探活不过」当「已停」，
    // 健康检查不过的服务当场就被报成已停，进程其实还在、端口还在听（2026-10-18 修）
    const gone = await waitFor(async () => !(await this.liveness(svc, st)).running, { timeoutMs: deadlineMs, intervalMs: 1000 });

    if (!gone) {
      // 兜底强杀，必须带进程树（服务常是好几层进程，只杀最上层会留下继续吃资源的孤儿）。杀的是「证明它还在跑」的那些进程：端口上的监听者、账本里核过身份的 PID、
      // 接入层报的 PID——原来只杀账本里的 PID，可健康检查不过时探活已经把它清掉了，结果一个都没杀
      const live = await this.liveness(svc, st);
      if (live.pids.length) {
        warn(`${id} 未在 ${deadlineMs}ms 内停下，taskkill /T /F ${force ? '（强制停止）' : '兜底'}`, { pids: live.pids, why: live.why });
        const killed = [];
        for (const pid of live.pids) killed.push(...(await this.killServiceTree(svc, pid)).killed);
        audit('force-kill', { id, pids: live.pids, killed, reason: force ? 'force' : 'stop-timeout' });
      }
      const goneNow = await waitFor(async () => !(await this.liveness(svc, st)).running, { timeoutMs: 10000, intervalMs: 500 });
      if (!goneNow) {
        st.state = 'FAILED';
        st.lastError = `停不下来：${force ? '强制停止' : '停机超时'}、杀了进程树之后${(await this.liveness(svc, st)).why || '还在跑'}`;
        this.persist();
        return { ok: false, why: st.lastError };
      }
    }

    st.state = 'STOPPED';
    st.pid = null; st.pidStart = null; st.runningSince = null;
    st.pendingStop = false;
    this.persist();
    info(`${id} 已停止`);
    return { ok: true };
  }

  /** 取消一个挂起的「等空闲再停」。服务侧也要撤销，否则它空闲时还是会自己退。 */
  async cancelPendingStop(id) {
    const st = this.st(id);
    if (!st.pendingStop) return { ok: false, why: `${id} 没有挂起的停机` };
    audit('cancel-stop', { id });
    const r = this.link?.status(id)?.connected ? await this.link.cancel(id) : { ok: false, why: '服务未接入，撤不回去' };
    st.pendingStop = false;
    st.desired = 'running';
    this.persist();
    return r.ok ? { ok: true } : { ok: false, why: `管理器这边已取消，但${r.why}` };
  }

  async restart(id, { mode = 'now', reason = 'manual' } = {}) {
    const svc = this.get(id);
    const st = this.st(id);
    const linked = this.link?.status(id)?.connected;
    audit('restart', { id, mode, reason });

    if (linked && this.link.status(id).capabilities?.includes('restart')) {
      // ⚠ 协议里的 restart 只走到「服务自己退出」为止：clients/lsm-link.mjs 的
      //   doShutdown 是 process.exit(0)，它不会自己再起来。**谁把它拉起来**
      //   link-protocol.md §4 从没写过，两边都以为是对方的活，于是 linked 服务的
      //   restart 长期等价于 stop —— 指令报 ✓，站点 502。
      //   （2026-09-29 实测到：restart 后 FAILED + 公网 502。
      //     link-demo 的 onboarding 只验过 [start, stop]，从来没验过 restart。）
      //   这一段由管理器补：等进程真的退干净，再按注册表的 start 钩子起回来。
      st.desired = 'running';
      this.persist();
      const r = await this.link.restart(id, { mode, deadlineMs: 600000 });
      if (!r.ok) { await this.refresh(); return r; }
      // when-idle 可能挂起很久（协议规定它永远不被强杀），等它退的上限就用同一个 deadline。
      // 退没退看进程和端口，不看健康检查——否则健康检查不过时会当它退了，接着在它还占着的端口上再起一份
      const down = await waitFor(async () => !(await this.liveness(svc, st)).running,
        { timeoutMs: mode === 'when-idle' ? 600000 : 60000, intervalMs: 1000 });
      if (!down) {
        await this.refresh();
        return { ok: false, why: `restart：服务 ack 了但没退出（${(await this.liveness(svc, st)).why || '还在跑'}），未敢重复拉起` };
      }
      return await this.start(id, { reason: 'restart' });
    }
    if (svc.hooks.restart) {
      st.desired = 'running';
      st.state = 'STARTING';
      st.readyDeadline = Date.now() + (svc.hooks.restart.readyTimeoutMs ?? 60000);
      this.persist();
      const r = await runHook(svc, 'restart', { extraEnv: this.linkEnv(svc), logFile: this.outLog(id) });
      if (!r.ok) {
        st.state = 'FAILED';
        st.lastError = `restart 钩子失败（${r.reason}）：${(r.stderr || '').slice(-500)}`;
        this.persist();
        return { ok: false, why: st.lastError };
      }
      const ready = await waitFor(async () => {
        const snap = await snapshot([svc]);
        return (await probeService(svc, st, snap, this.linkStatus)).ok;
      }, { timeoutMs: svc.hooks.restart.readyTimeoutMs ?? 60000, intervalMs: 1000 });
      await this.refresh();
      return ready ? { ok: true } : { ok: false, why: 'restart 后未在 readyTimeout 内就绪' };
    }
    if (svc.hooks.stop && svc.hooks.start) {
      const s = await this.stop(id, { mode, reason: 'restart' });
      if (!s.ok) return s;
      return await this.start(id, { reason: 'restart' });
    }
    return { ok: false, why: `${id} 既没有 restart 能力，也无法用 stop+start 拼出来` };
  }

  /**
   * 场景成员 = manager.yaml 里列的 + 每个服务自己 `profiles:` 声明的，取并集。
   *
   * 之前只认 manager.yaml，结果是两个真理源打架：给一个服务加了隧道、隧道 yaml 里
   * 写了 `profiles: [game]`，`lsm profile game` 却只起服务不起隧道。
   * 按「一服务一文件」，服务自己的声明必须算数——否则每加一个服务
   * 都要回头改中心文件，纳管 skill 也得多改一处。
   */
  profileMembers(name) {
    const ids = new Set(this.manager.profiles?.[name] || []);
    for (const svc of this.services.values()) {
      if ((svc.profiles || []).includes(name)) ids.add(svc.id);
    }
    return [...ids];
  }

  /** 场景：一组会被同时启停的服务（GPU 是独占资源，所以有场景、没有「一键全开」）。同层并发，层间串行。 */
  async startProfile(name) {
    const ids = this.profileMembers(name);
    if (!ids.length) return { ok: false, why: `没有这个场景：${name}` };
    audit('start-profile', { profile: name, ids });
    const layers = topoLayers(this.services, ids);
    const results = [];
    for (const layer of layers) {
      const rs = await Promise.all(layer.map((id) => this.start(id, { reason: `场景 ${name}` })));
      layer.forEach((id, i) => results.push({ id, ...rs[i] }));
    }
    return { ok: results.every((r) => r.ok), results };
  }

  async stopProfile(name, { force = false } = {}) {
    const ids = this.profileMembers(name);
    if (!ids.length) return { ok: false, why: `没有这个场景：${name}` };
    audit('stop-profile', { profile: name, ids });
    const layers = topoLayers(this.services, ids).reverse();   // 反向拆：先停依赖别人的
    const results = [];
    for (const layer of layers) {
      const rs = await Promise.all(layer.map((id) => this.stop(id, { force, reason: `场景 ${name}` })));
      layer.forEach((id, i) => results.push({ id, ...rs[i] }));
    }
    return { ok: results.every((r) => r.ok), results };
  }

  /** 裁决孤儿：认领（写进账本）或杀掉。管理器从不静默处理。 */
  async resolveOrphan(id, action) {
    const svc = this.get(id);
    const st = this.st(id);
    audit('resolve-orphan', { id, action, pid: st.pid });
    if (action === 'adopt') {
      const snap = await snapshot([svc]);
      const owners = snap.ports.get(svc.probe.port) || [];
      if (!owners.length) return { ok: false, why: '端口上已经没人了' };
      st.pid = owners[0];
      st.pidStart = snap.procs.get(owners[0])?.start ?? null;
      st.desired = 'running';
      st.state = 'RUNNING';
      this.persist();
      return { ok: true, pid: st.pid };
    }
    if (action === 'kill') {
      const snap = await snapshot([svc]);
      const owners = snap.ports.get(svc.probe.port) || [];
      for (const pid of owners) await this.killServiceTree(svc, pid);
      await this.refresh();
      return { ok: true, killed: owners };
    }
    return { ok: false, why: `未知裁决：${action}` };
  }

  /**
   * 强杀一个服务。先找到服务树的真正树顶再杀——只杀 st.pid 的话，
   * 像 hub.ps1 那种「自带重启循环的父进程」会立刻把服务再拉起来，
   * 看上去就像服务自己复活了（2026-08-23 接管一个项目时实测踩到）。
   */
  async killServiceTree(svc, pid) {
    if (!pid) return { killed: [] };
    const procs = await allProcesses();
    const script = /([\w.-]+\.(?:ps1|mjs|js|py))/i.exec(svc.hooks?.start?.cmd || '')?.[1];
    // 绝不认到管理器自己头上（见 findServiceTreeTop 的 stopAt）
    const top = findServiceTreeTop(pid, procs, [svc.root, script], { stopAt: [process.pid, process.ppid] });
    if (top !== pid) {
      warn(`${svc.id}: 监听进程 ${pid} 的上面还有自带重启循环的父进程 ${top}（${procs.get(top)?.name}），连它一起杀`);
    }
    await killTree(top);
    return { killed: [top] };
  }

  /**
   * 给一个还只在本地的服务开通公网入口：生成一条隧道服务、写进注册表、起起来。
   *
   * 诚实说明它做不到的那一半：隧道只把本机端口送到 VPS 的回环地址上。
   * 真正对公网提供服务还需要 VPS 上有一段 nginx 反代指向那个回环端口——
   * 那是**远端机器的配置**，不在管理器的管辖范围（v1 只管本机），所以这里只把
   * 该贴的 nginx 片段生成给你，绝不擅自去改 VPS。
   */
  async createExposure(id, { remotePort } = {}) {
    const svc = this.get(id);
    const vps = this.manager.vps || {};
    // 「能不能开」只有一个答案来源，界面上的按钮也从它取（含 exposure.never 的禁令）
    const can = exposureCreatable(svc, vps);
    if (!can.ok) return { ok: false, why: can.why };
    // 密钥文件不在就别生成隧道：生成出来也只会一遍遍 Permission denied（2026-10-08 实测，
    // manager.yaml 里的路径被转义符吃坏了——\v、\a 变成了控制字符，一条隧道因此连不上）
    if (!fs.existsSync(vps.key)) return { ok: false, why: `registry/manager.yaml 的 vps.key 指向的密钥文件不存在：${JSON.stringify(vps.key)}` };

    const port = exposedPort(svc);
    const remote = Number(remotePort) || 10000 + port;
    const tunnelId = `${id}-tunnel`;
    const file = path.join(SERVICES_DIR, `${tunnelId}.yaml`);
    if (fs.existsSync(file)) return { ok: false, why: `${tunnelId}.yaml 已存在，请直接编辑它` };

    // argv 而不是 cmd 字符串：唯一能做到零窗口的形式（2026-08-24 实测：只有经 PowerShell 包装的 ssh 会冒窗口）。
    // 这里以前生成的是 `cmd: ssh ...`，那会经 shell 包装、被 Windows Terminal 开成可见黑窗口——
    // 也就是说「WebUI 上点接通公网」会凭空多出一个黑框，正是当初花一天消灭掉的东西。
    // -n -T：不读 stdin、不要伪终端。
    const sshArgv = [
      'ssh', '-i', vps.key, '-N', '-n', '-T',
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-R', `127.0.0.1:${remote}:127.0.0.1:${port}`, vps.host,
    ];

    fs.writeFileSync(file, [
      `id: ${tunnelId}`,
      `name: ${svc.name} 的公网隧道`,
      `project: ${svc.project || ''}`,
      `root: ${svc.root}`,
      'kind: managed',
      'role: tunnel        # 纯隧道：UI 上不单独占卡片，作为被暴露服务的一部分显示',
      '',
      '# 由管理器在 ' + new Date().toISOString().slice(0, 10) + ' 自动生成（WebUI 上点「接通公网」）。',
      '# ssh 本身不重连，重连交给下面的 autoRestart —— 这样「谁在重启它」永远只有一个答案。',
      'probe:',
      '  tier: process',
      `  matchCmd: ${remote}:127.0.0.1:${port}`,
      'capabilities: [start]',
      '',
      'hooks:',
      '  start:',
      '    argv:',
      ...sshArgv.map((a) => `      - ${/[:\s#]/.test(a) ? JSON.stringify(a) : a}`),
      '    detaches: false',
      '    readyTimeoutMs: 20000',
      '',
      'autoRestart:',
      '  enabled: true',
      '  maxRetries: 20',
      '  backoffMs: [5000, 15000, 60000]',
      '',
    ].join('\n'), 'utf-8');

    // 给被暴露的服务补上 exposure 块。用文本追加而不是 YAML 重写——重写会把注释全吃掉。
    if (!svc.exposure) {
      fs.appendFileSync(svc._file, [
        '',
        '# 由管理器自动添加（WebUI 上点「接通公网」）',
        'exposure:',
        `  via: ${tunnelId}`,
        `  remotePort: ${remote}`,
        '  publicUrl: null      # VPS 上配好 nginx 站点后把地址填这里，才能开启公网可达性实测',
        '  check: false',
        '',
      ].join('\n'), 'utf-8');
    }

    audit('create-exposure', { id, tunnelId, remote, port });
    this.reload();
    const r = await this.start(tunnelId);
    const nginx = [
      `# 本 VPS 的 443 属于 stream{} 的 SNI 前门：只能 listen 127.0.0.1:8443，写 listen 443 会让所有站点一起挂`,
      `server {`,
      `    listen 127.0.0.1:8443 ssl;`,
      `    server_name <你的域名>;`,
      `    location / {`,
      `        proxy_pass http://127.0.0.1:${remote};`,
      `        proxy_http_version 1.1;`,
      `        proxy_set_header Upgrade $http_upgrade;`,
      `        proxy_set_header Connection "upgrade";`,
      `        proxy_set_header Host $host;`,
      `    }`,
      `}`,
    ].join('\n');
    return {
      ...r,
      tunnelId,
      remotePort: remote,
      note: `隧道已建立：本机 ${port} → ${vps.host} 的 127.0.0.1:${remote}。\n`
        + `公网还差 VPS 上的 nginx 站点（管理器只管本机，不会去改 VPS）。把下面这段加到 VPS 的 nginx 里：\n\n${nginx}\n\n`
        + `配好之后把公网地址填进 registry/services/${id}.yaml 的 exposure.publicUrl，并把 check 改成 true。`,
    };
  }

  /**
   * 摘掉项目原有的自启入口。纳管是一次搬迁，不是一次登记——
   * 最危险的状态是「纳管了但旧任务还在跑」，两个东西抢同一个端口（一个服务只能有一个管理者）。
   */
  async detachTask(taskName) {
    if (!taskName) return { ok: false, why: '没给任务名' };
    audit('detach-task', { task: taskName });
    try {
      await unregisterScheduledTask(taskName);
      info(`已摘除计划任务：${taskName}`);
      return { ok: true };
    } catch (e) {
      const msg = String(e.message || e);
      // 由提权进程注册的任务，其任务文件的 ACL 只给普通用户 Read——删除必须管理员。
      // 这里不能静默失败：任务留着就是「两个东西管同一个服务」，下次登录必然抢端口。
      if (/拒绝访问|Access is denied/i.test(msg)) {
        return {
          ok: false, needsElevation: true,
          why: `需要管理员权限（这个任务是提权注册的）。请在管理员 PowerShell 里执行：\n` +
               `   Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false`,
        };
      }
      return { ok: false, why: `摘不掉：${msg.slice(0, 300)}` };
    }
  }

  // ---------------------------------------------------------------- Tailnet 入口

  /** 网关监听的本机端口 = 网关服务的探活端口。 */
  tailnetGatewayPort() {
    return this.services.get(this.manager.tailnet?.gateway)?.probe?.port ?? null;
  }

  writeTailnetRoutes() {
    tn.writeRoutes(tn.routesFor(this.tailnetEntries, this.services, this.manager.tailnet));
  }

  /**
   * 给一个服务开 tailnet 入口。顺序有讲究：先把 VPS 那一半做完（证书、DNS 记录），证书拉回本机，
   * 最后才写本机清单、起网关、配 serve——任何一步失败都不会留下「清单里有、证书却没有」的半截状态。
   * 这是管理器少数会去改 VPS 的地方，只改两样：certbot 签 *.<domain>、headscale 的 DNS 记录文件。
   */
  async openTailnet(id, { name } = {}) {
    const svc = this.get(id);
    const cfg = this.manager.tailnet;
    const vps = this.manager.vps;
    if (this.tailnetListError) return { ok: false, why: `${this.tailnetListError}——先把这个文件修好` };
    if (this.tailnetEntries.has(id)) return { ok: false, why: `${id} 已经有 tailnet 入口了` };
    const can = tn.tailnetCreatable(svc, cfg, vps);
    if (!can.ok) return { ok: false, why: can.why };
    if (!fs.existsSync(vps.key)) return { ok: false, why: `vps.key 指向的密钥文件不存在：${JSON.stringify(vps.key)}` };
    const gw = cfg.gateway;
    if (!this.services.has(gw)) return { ok: false, why: `网关服务 ${gw} 没登记` };
    name = (name || tn.defaultName(svc)).toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return { ok: false, why: `"${name}" 不是合法的域名标签` };
    const taken = [...this.tailnetEntries].find(([, e]) => e.name === name);
    if (taken) return { ok: false, why: `名字 ${name} 已经给了 ${taken[0]}` };

    const node = await tn.nodeStatus(cfg);
    if (!node.ok || !node.self?.ipv4) return { ok: false, why: `本机的 tailscale 不在线（${node.why || node.backend}），没法把名字指到本机` };
    const host = tn.hostOf(name, cfg);
    const entries = new Map(this.tailnetEntries).set(id, { name });
    const hosts = [...entries.values()].map((e) => tn.hostOf(e.name, cfg));

    const cur = await tn.readRecords(vps, cfg);
    if (!cur.ok) return { ok: false, why: cur.why };
    const applied = await tn.vpsApply(vps, cfg, { certHosts: [host], records: tn.mergeRecords(cur.records, hosts, node.self.ipv4, cfg.domain) });
    if (applied.issued.length) audit('tailnet-cert-issued', { hosts: applied.issued });
    if (!applied.ok) return { ok: false, why: applied.why };
    const cert = await tn.pullCert(vps, host);
    if (!cert.ok) return { ok: false, why: cert.why };

    this.tailnetEntries = entries;
    tn.saveTailnetList(entries);
    this.writeTailnetRoutes();
    audit('tailnet-open', { id, host, port: exposedPort(svc), certIssued: applied.issued.includes(host) });
    info(`tailnet 入口已开：${id} → https://${host}/`);

    const started = await this.start(gw);
    if (!started.ok) return { ok: false, why: `VPS 和证书都好了，但网关 ${gw} 没起来：${started.why}` };
    let serve;
    try { serve = await tn.ensureServe(cfg, this.tailnetGatewayPort(), true); } catch (e) { serve = { ok: false, why: e.stderr?.trim() || e.message }; }
    if (!serve.ok) return { ok: false, why: `网关起来了，但 tailscale serve 没配上：${serve.why}` };
    if (serve.changed) audit('tailnet-serve', { on: true, target: serve.target });
    await this.refreshTailnet();
    const chk = this.tailnetChecks.get(id);
    return {
      ok: true, url: `https://${host}/`, check: chk,
      note: `tailnet 入口：https://${host}/\n\n`
        + `手机上先打开 Tailscale 连上 tailnet（并保持「使用 Tailscale DNS」开着），再用浏览器打开上面的地址。\n`
        + `不连 tailnet 时这个名字解析到 VPS，打不开——这是故意的：它只在 tailnet 里通。`
        + (applied.issued.includes(host) ? `\n\n（这次在 VPS 上新签了证书${tn.stopUnits(cfg).length ? `，${tn.stopUnits(cfg).join('、')} 停了约 10 秒` : ''}。）` : ''),
    };
  }

  async closeTailnet(id) {
    const cfg = this.manager.tailnet;
    const vps = this.manager.vps;
    if (this.tailnetListError) return { ok: false, why: `${this.tailnetListError}——先把这个文件修好` };
    const e = this.tailnetEntries.get(id);
    if (!e) return { ok: false, why: `${id} 没有 tailnet 入口` };
    const host = tn.hostOf(e.name, cfg);
    // 本机先撤：路由表一改，网关 5 秒内就不再接这个名字
    const entries = new Map(this.tailnetEntries);
    entries.delete(id);
    this.tailnetEntries = entries;
    tn.saveTailnetList(entries);
    this.writeTailnetRoutes();
    audit('tailnet-close', { id, host });
    info(`tailnet 入口已撤：${id}（${host}）`);
    const problems = [];
    // VPS 上撤 DNS 记录；证书留着（不碍事，下次再开不用重签）
    const cur = await tn.readRecords(vps, cfg);
    const hosts = [...entries.values()].map((x) => tn.hostOf(x.name, cfg));
    if (!cur.ok) problems.push(cur.why);
    else {
      const node = await tn.nodeStatus(cfg);
      const r = await tn.vpsApply(vps, cfg, { records: tn.mergeRecords(cur.records, hosts, node.self?.ipv4, cfg.domain) });
      if (!r.ok) problems.push(r.why);
    }
    if (!entries.size) {
      try {
        const s = await tn.ensureServe(cfg, this.tailnetGatewayPort(), false);
        if (s.changed) audit('tailnet-serve', { on: false });
      } catch (err) { problems.push(`tailscale serve 没撤掉：${err.stderr?.trim() || err.message}`); }
      const st = this.st(cfg.gateway);
      if (st.state !== 'STOPPED') await this.stop(cfg.gateway, { force: true });
    }
    await this.refreshTailnet();
    return problems.length
      ? { ok: false, why: `本机已撤（网关不再接 ${host}），但还有没做完的：${problems.join('；')}` }
      : { ok: true };
  }

  /** 慢周期调用：本机节点状态、各入口实测；证书每 6 小时从 VPS 拉一次（续期后的新证书就这样回来）。 */
  async refreshTailnet() {
    const cfg = this.manager.tailnet;
    if (!cfg?.domain) { this.tailnetNode = null; this.tailnetChecks = new Map(); return; }
    this.tailnetNode = await tn.nodeStatus(cfg);
    const gwPort = this.tailnetGatewayPort();
    const certDue = Date.now() - (this.tailnetCertSyncedAt || 0) > 6 * 3600_000;
    const checks = new Map();
    for (const [id, e] of this.tailnetEntries) {
      const host = tn.hostOf(e.name, cfg);
      let cert = this.tailnetCerts?.get(id) || null;
      if (certDue && this.manager.vps?.key) {
        cert = await tn.pullCert(this.manager.vps, host);
        if (cert.ok && cert.changed) { audit('tailnet-cert-pulled', { id, host, notAfter: new Date(cert.notAfter).toISOString() }); info(`tailnet 证书已更新：${host}`); }
        if (!cert.ok) warn(`tailnet 证书拉不回来：${cert.why}`);
      }
      if (!cert) {
        try {
          const dir = tn.certDir(host);
          cert = { ok: true, ...tn.inspectCert(fs.readFileSync(path.join(dir, 'fullchain.pem'), 'utf-8'), fs.readFileSync(path.join(dir, 'privkey.pem'), 'utf-8'), host) };
        } catch (err) { cert = { ok: false, why: `本机没有可用的证书：${err.message}` }; }
      }
      (this.tailnetCerts ||= new Map()).set(id, cert);
      checks.set(id, { ...(gwPort ? await tn.checkEntry(host, gwPort, this.tailnetNode) : { ok: false }), cert });
    }
    if (certDue && this.tailnetEntries.size) this.tailnetCertSyncedAt = Date.now();
    this.tailnetChecks = checks;
  }

  /**
   * VPS 费用：慢周期每分钟调一次，到点才真的去阿里云查。
   *  - 查成功了：隔 intervalMs（默认 3 小时）再查；
   *  - 有几项查不到（权限、填错）：隔 10 分钟——你可能正在改；
   *  - 还没放凭证文件：每次都看一眼文件在不在（不联网），放好一分钟内就生效。
   * WebUI 的「刷新」和 `lsm vps refresh` 带 force，立刻查。
   * 提醒：界面上一直显示；cfg.notify 开着时弹 Windows 通知，同一条一天最多一次（发过的记在账本里，重启不会重弹）。
   */
  async refreshVpsBilling({ force = false } = {}) {
    const cfg = vb.billingConfig(this.manager);
    if (!cfg) return { ok: false, why: 'manager.yaml 里没配 vps.billing' };
    if (this.billingBusy) return this.billingBusy;
    const last = this.state.vpsBilling;
    const every = !last?.configured ? 0 : last.ok ? cfg.intervalMs : 10 * 60_000;
    if (!force && last && Date.now() - last.checkedAt < every) return { ok: true, cached: true };

    this.billingBusy = (async () => {
      const b = await vb.fetchBilling(cfg);
      this.state.vpsBilling = b;
      const alerts = vb.billingAlerts(b, cfg);
      const sig = JSON.stringify([b.configured, alerts.map((a) => a.key + a.level), (b.errors || []).map((e) => e.part)]);
      if (sig !== this.billingSig) {
        this.billingSig = sig;
        if (!b.configured) info(`VPS 费用：${b.why}`);
        for (const e of b.errors || []) warn(`VPS 费用：${e.part}查不到——${e.why}`);
        if (alerts.length) warn(`VPS 费用提醒：${alerts.map((a) => a.text).join('；')}`);
        else if (b.configured) info('VPS 费用：没有要提醒的');
      }
      if (cfg.notify && alerts.length) {
        const { due, notified } = vb.dueNotifications(alerts, this.state.vpsBillingNotified);
        if (due.length) {
          try {
            await toast(due.some((a) => a.key.startsWith('expiry')) ? 'VPS 订阅快到期了，该续费了' : 'VPS 费用提醒', due.map((a) => a.text),
              { url: `http://127.0.0.1:${this.manager.port}/` });
            this.state.vpsBillingNotified = notified;
          } catch (e) { warn('VPS 费用提醒：系统通知发不出去', { error: String(e?.message || e).slice(0, 300) }); }
        }
      }
      this.persist();
      const why = b.configured ? (b.errors || []).map((e) => `${e.part}：${e.why}`).join('；') : b.why;
      return { ok: b.configured && b.ok, why: why || undefined, alerts };
    })().finally(() => { this.billingBusy = null; });
    return this.billingBusy;
  }

  /**
   * 三种入口。局域网 URL 只在服务**真的绑在 0.0.0.0** 时才给——
   * 只绑 127.0.0.1 的服务，给它一个局域网地址就是骗人（打不开）。
   */
  urlsOf(svc, st, exp) {
    const port = svc.probe.port;
    const scheme = svc.probe.health?.url?.startsWith('https') ? 'https' : 'http';
    const binds = st.bindAddrs || [];
    const wildcard = binds.some((a) => a === '0.0.0.0' || a === '[::]' || a === '::');
    const ip = lanIp();
    return {
      local: port ? `${scheme}://127.0.0.1:${port}` : null,
      lan: port && wildcard && ip ? `${scheme}://${ip}:${port}` : null,
      lanWhy: port && !wildcard ? `服务绑在 ${binds.join('/') || '未知地址'}，局域网访问不了` : null,
      public: exp.scope === 'public' ? (exp.publicUrl || null) : null,
    };
  }

  snapshotForUi() {
    const tunnelFor = new Map();   // 隧道 id -> 它服务于哪个服务
    for (const svc of this.services.values()) {
      if (svc.exposure?.via && this.services.get(svc.exposure.via)?.role === 'tunnel') {
        tunnelFor.set(svc.exposure.via, svc.id);
      }
    }
    const tcfg = this.manager.tailnet;
    const gwId = tcfg?.gateway;
    const bcfg = vb.billingConfig(this.manager);
    return {
      // 只有查询结果和设置；凭证只给文件路径（教你放哪），内容永远不出管理器
      vps: bcfg ? {
        site: bcfg.site,
        minBalance: bcfg.minBalance, remindDays: bcfg.remindDays, notify: bcfg.notify,
        credentials: bcfg.credentials,
        links: vb.linksFor(bcfg.site),
        billing: this.state.vpsBilling || null,
        alerts: vb.billingAlerts(this.state.vpsBilling, bcfg),
        refreshing: !!this.billingBusy,
      } : null,
      manager: { startedAt: this.state.manager?.startedAt ?? null, registryErrors: this.registryErrors },
      tailnet: tcfg?.domain ? {
        domain: tcfg.domain,
        stopUnits: tn.stopUnits(tcfg),
        node: this.tailnetNode || null,
        gateway: gwId ? { id: gwId, port: this.tailnetGatewayPort(), state: this.st(gwId).state, autostart: this.bootList.has(gwId) } : null,
        entries: this.tailnetEntries.size,
        listError: this.tailnetListError,
      } : null,
      bootList: [...this.bootList].sort(),
      bootListError: this.bootListError,
      profiles: Object.fromEntries(
        [...new Set([
          ...Object.keys(this.manager.profiles || {}),
          ...[...this.services.values()].flatMap((s) => s.profiles || []),
        ])].map((n) => [n, this.profileMembers(n)]),
      ),
      services: [...this.services.values()].map((svc) => {
        const st = this.st(svc.id);
        const link = this.link?.status(svc.id);
        const exp = exposureOf(svc);
        const viaSt = exp.via ? this.st(exp.via) : null;
        const viaSvc = exp.via ? this.services.get(exp.via) : null;
        return {
          role: svc.role || null,
          // 纯隧道不单独占一张卡片，它作为被暴露服务的一部分显示
          tunnelFor: tunnelFor.get(svc.id) || null,
          urls: this.urlsOf(svc, st, exp),
          ...(() => {
            const can = exposureCreatable(svc, this.manager.vps);
            return {
              canCreateExposure: can.ok,
              // 开不了的原因如实给界面，别再让它猜（原来一律显示「没有端口或未配 VPS」）
              exposureBlockedWhy: can.ok ? null : can.why,
              exposureNever: svc.exposure?.never || null,
            };
          })(),
          exposure: {
            ...exp,
            // 隧道进程在跑 ≠ 公网通着。前者是 viaState，后者是 publicCheck 的实测结果。
            viaState: viaSt?.state ?? null,
            viaDetail: viaSt?.detail ?? null,
            viaLog: viaSvc ? true : false,
            publicCheck: this.exposureChecks?.get(svc.id) ?? null,
          },
          ...(() => {
            const e = this.tailnetEntries.get(svc.id);
            const can = tn.tailnetCreatable(svc, this.manager.tailnet, this.manager.vps);
            return {
              tailnet: e ? { name: e.name, url: `https://${tn.hostOf(e.name, this.manager.tailnet)}/`, check: this.tailnetChecks?.get(svc.id) ?? null } : null,
              tailnetPort: exposedPort(svc),
              tailnetName: e?.name ?? tn.defaultName(svc),
              canOpenTailnet: !e && can.ok && !svc.role,
              tailnetBlockedWhy: can.ok ? null : can.why,
            };
          })(),
          autostart: this.bootList.has(svc.id),
          autostartBlocked: autostartBlocked(svc),
          // 名下的服务：由哪个接入的项目经协议登记。卡片上标「由 X 登记」，你照样能手动启停
          owner: svc.owner || null,
          registeredAt: svc.registeredAt || null,
          id: svc.id, name: svc.name, project: svc.project, kind: svc.kind,
          port: svc.probe.port, tier: st.tier || svc.probe.tier,
          declaredTier: svc.probe.tier,
          // 接入后 stop/restart/health/busy 以服务自报为准；start 永远来自注册表——
          // 一个正在跑的服务没法自报「我能被启动」，之前这里把 start 弄丢了。
          capabilities: link?.connected && link.capabilities
            ? [...new Set([...link.capabilities, ...svc.capabilities.filter((c) => c === 'start')])]
            : svc.capabilities,
          linked: !!link?.connected,
          state: st.state, detail: st.detail, busy: !!st.busy, busyReason: st.busyReason,
          degradedObservation: !!st.degradedObservation,
          pid: st.pid, runningSince: st.runningSince, lastError: st.lastError,
          pendingStop: !!st.pendingStop,
          orphanWhy: st.orphanWhy, logs: svc.logs, profiles: svc.profiles,
          dependsOn: svc.dependsOn,
        };
      }),
    };
  }
}
