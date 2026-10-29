// 名下的服务：接入的项目经接入协议登记、启停、撤销**它自己名下的**服务。
//
// 起因：ergo（二狗）的守护进程 ergo-daemon 要把它做完的项目转成一个服务，到管理器上线。服务只能由管理器托管、
// 由它启动（一个服务只能有一个管理者），可原来登记服务只有一条路——人在 registry/services/ 下放 YAML 再 reload，
// 接入协议也只有 hello / 心跳 / 停机。于是项目没法替自己登记服务。
//
// 规矩（协议见 docs/link-protocol.md §7）：
//  - 命名空间：名下的服务 id = `<登记方>--<名字>`，登记方只能碰自己前缀下的；别人的、手写的，一概碰不到。
//  - 存放：registry/services/owned/<登记方>/<名字>.yaml——仍是中心注册表的一部分（服务清单只有管理器这一份），
//    WebUI / CLI 照样看得到、能手动管，卡片上标「由 X 登记」。
//  - 照注册表的规矩校验（和加载时同一个函数）；端口由登记方给，和已登记的撞了就拒（管理器不分配端口，只让冲突可见）。
//  - 独立常驻：管理器自己 spawn（detaches: false），和登记方的进程、连接都没有关系——
//    登记方掉线、重启，服务照跑。
//  - 不替它伪造能力：定义里没给停机命令、也没接入的，停 / 重启要显式带 force（杀进程树）。
//  - 公网入口默认不开（不写 exposure）。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { OWNED_DIR } from './paths.mjs';
import { parseService, validate, OWNED_SEP, ownedIdOf } from './registry.mjs';
import { info, audit } from './log.mjs';

/** 写在 welcome.features / hello.features 里的特性名：管理器支持名下的服务。 */
export const FEATURE = 'services';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * 看名字像密钥的环境变量，不许用 literal 把值写进注册表（「密钥不进注册表」，service-schema.md）。
 * 按下划线分段认：NODE_AUTH_TOKEN、OPENAI_API_KEY 会被挡；TOKENIZERS_PARALLELISM 不会。
 * 只挡明显的，不保证挡全——登记方自己仍要守这条。
 */
const SECRET_NAME_RE = /(?:^|_)(?:API_?KEY|SECRET(?:_KEY)?|TOKEN|PASSW(?:OR)?D|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY)(?:_|$)/i;
/** 服务定义里能写的字段：service-schema.md 的一个子集——够起一个常驻服务、探活、看日志，碰不到钩子和公网入口这些要人拍板的。 */
export const DEF_FIELDS = ['name', 'title', 'project', 'command', 'argv', 'cwd', 'env', 'port', 'health',
  'autostart', 'autoRestart', 'readyTimeoutMs', 'link', 'stop', 'logs'];
const UP = ['RUNNING', 'DEGRADED'];
const LIVE = ['RUNNING', 'DEGRADED', 'STARTING', 'STOPPING'];

const fail = (code, why, details) => ({ ok: false, code, why, ...(details ? { details } : {}) });
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * 请求里的 name → 这个登记方名下的 id。
 * 可以写短名（web），也可以写全名（ergo-daemon--web）；带了 `--` 却不是自己的前缀 = 想碰别人的服务，拒。
 */
export function resolveName(owner, raw) {
  if (typeof raw !== 'string' || !raw) return fail('bad-request', '缺少 name（名下服务的名字）');
  const prefix = owner + OWNED_SEP;
  let name = raw;
  if (name.startsWith(prefix)) name = name.slice(prefix.length);
  else if (name.includes(OWNED_SEP)) return fail('not-owner', `"${raw}" 不在 ${owner} 名下：名下的服务一律叫 ${prefix}<名字>，别人的服务碰不到`);
  if (!NAME_RE.test(name) || name.includes(OWNED_SEP)) {
    return fail('invalid', `名字 "${name}" 不合规：小写字母、数字、连字符，1–48 个字符，首尾不能是连字符，不能含 "--"`);
  }
  return { ok: true, name, id: ownedIdOf(owner, name) };
}

/** 服务定义的形状校验（不碰注册表）。返回逐条原因；空数组 = 通过。 */
export function definitionErrors(def, { managerPort = null } = {}) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return ['service 必须是一个对象'];
  const errs = [];
  for (const k of Object.keys(def)) if (!DEF_FIELDS.includes(k)) errs.push(`不认识的字段 "${k}"（能写的：${DEF_FIELDS.join('、')}）`);

  const hasCmd = def.command != null;
  const hasArgv = def.argv != null;
  if (hasCmd === hasArgv) errs.push('command（字符串）和 argv（数组）必须给且只给一个');
  if (hasCmd) {
    if (typeof def.command !== 'string' || !def.command.trim()) errs.push('command 必须是非空字符串');
    else if (/[\r\n]/.test(def.command)) errs.push('command 里不能有换行');
  }
  if (hasArgv) {
    if (!Array.isArray(def.argv) || !def.argv.length || def.argv.some((a) => typeof a !== 'string' || !a)) errs.push('argv 必须是非空字符串组成的非空数组');
    else if (def.argv.some((a) => /["%\r\n]/.test(a))) errs.push('argv 参数里不能有 " % 或换行（服务的命令要经 cmd 一层，cmd 会改写它们）');
  }

  if (typeof def.cwd !== 'string' || !def.cwd) errs.push('缺少 cwd（服务的工作目录，绝对路径）');
  else if (!path.isAbsolute(def.cwd)) errs.push(`cwd 必须是绝对路径：${def.cwd}`);
  else if (!isDir(def.cwd)) errs.push(`cwd 不存在或不是目录：${def.cwd}`);

  if (!Number.isInteger(def.port) || def.port < 1 || def.port > 65535) {
    errs.push('port 必须是 1–65535 的整数——端口是服务的身份，由你给，管理器不分配');
  } else if (managerPort && def.port === managerPort) errs.push(`port ${def.port} 是管理器自己的端口`);

  if (def.health != null) {
    const h = def.health;
    if (typeof h !== 'object' || Array.isArray(h)) errs.push('health 必须是对象：{ path: "/health", timeoutMs?: 3000 }');
    else {
      for (const k of Object.keys(h)) if (!['path', 'timeoutMs'].includes(k)) errs.push(`health 里不认识的字段 "${k}"（能写的：path、timeoutMs）`);
      if (typeof h.path !== 'string' || !h.path.startsWith('/') || /[\s#]/.test(h.path)) {
        errs.push('health.path 必须是以 / 开头的路径，比如 /health（管理器去打 http://127.0.0.1:<port><path>）');
      }
      if (h.timeoutMs != null && !(Number.isInteger(h.timeoutMs) && h.timeoutMs >= 100 && h.timeoutMs <= 60000)) errs.push('health.timeoutMs 必须是 100–60000 的整数');
    }
  }

  if (def.env != null) {
    if (!Array.isArray(def.env)) errs.push('env 必须是数组：[{ name, from: userEnv | file | literal, ... }]');
    else {
      const seen = new Set();
      def.env.forEach((e, i) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) { errs.push(`env[${i}] 必须是对象`); return; }
        for (const k of Object.keys(e)) if (!['name', 'from', 'path', 'value', 'optional'].includes(k)) errs.push(`env[${i}] 里不认识的字段 "${k}"`);
        if (typeof e.name !== 'string' || !ENV_NAME_RE.test(e.name)) { errs.push(`env[${i}].name 不合规：${JSON.stringify(e.name)}`); return; }
        const key = e.name.toUpperCase();   // Windows 的环境变量不分大小写
        if (seen.has(key)) errs.push(`env ${e.name} 重复`);
        seen.add(key);
        if (/^LSM_/i.test(e.name)) errs.push(`env ${e.name}：LSM_ 开头的变量是管理器注入的接入身份，不能自己写`);
        if (!['userEnv', 'file', 'literal'].includes(e.from)) errs.push(`env ${e.name}: from 必须是 userEnv / file / literal`);
        if (e.from === 'file' && (typeof e.path !== 'string' || !e.path)) errs.push(`env ${e.name}: from=file 必须给 path`);
        if (e.from === 'literal') {
          if (!['string', 'number', 'boolean'].includes(typeof e.value)) errs.push(`env ${e.name}: from=literal 必须给 value（字符串 / 数字 / 布尔）`);
          else if (SECRET_NAME_RE.test(e.name)) {
            errs.push(`env ${e.name} 看名字是密钥，不能用 literal 把值写进注册表——改用文件读（from: file，密钥放文件里，注册表只写路径）或用户环境变量读（from: userEnv）`);
          }
        }
        if (e.optional != null && typeof e.optional !== 'boolean') errs.push(`env ${e.name}: optional 必须是 true / false`);
      });
    }
  }

  for (const k of ['autostart', 'autoRestart', 'link']) if (def[k] != null && typeof def[k] !== 'boolean') errs.push(`${k} 必须是 true / false`);
  if (def.readyTimeoutMs != null && !(Number.isInteger(def.readyTimeoutMs) && def.readyTimeoutMs >= 1000 && def.readyTimeoutMs <= 600000)) {
    errs.push('readyTimeoutMs 必须是 1000–600000 的整数');
  }
  if (def.stop != null) {
    const s = def.stop;
    if (typeof s !== 'object' || Array.isArray(s)) errs.push('stop 必须是对象：{ command: "...", timeoutMs?: 60000 }');
    else {
      for (const k of Object.keys(s)) if (!['command', 'timeoutMs'].includes(k)) errs.push(`stop 里不认识的字段 "${k}"（能写的：command、timeoutMs）`);
      if (typeof s.command !== 'string' || !s.command.trim() || /[\r\n]/.test(s.command)) errs.push('stop.command 必须是一行非空的命令');
      if (s.timeoutMs != null && !(Number.isInteger(s.timeoutMs) && s.timeoutMs >= 1000 && s.timeoutMs <= 600000)) errs.push('stop.timeoutMs 必须是 1000–600000 的整数');
    }
  }
  for (const k of ['title', 'project']) {
    if (def[k] != null && (typeof def[k] !== 'string' || !def[k].trim() || def[k].length > 80 || /[\r\n]/.test(def[k]))) errs.push(`${k} 必须是一行字，最多 80 个字`);
  }
  if (def.logs != null) {
    if (!Array.isArray(def.logs) || def.logs.some((l) => !l || typeof l.path !== 'string' || !l.path || (l.label != null && typeof l.label !== 'string'))) {
      errs.push('logs 必须是 [{ path, label? }] 数组（管理器只 tail，不采集）');
    }
  }
  return errs;
}

/**
 * 服务定义 → 注册表里的那份 YAML 对象。字段的意思和手写的注册表完全一样（service-schema.md）。
 * prevRaw：更新时原来那份。你在 WebUI 上给它开的公网入口（exposure）照留——那是你的选择，不归登记方管。
 */
export function buildRaw(owner, name, def, { ownerProject = '', prevRaw = null, now = new Date().toISOString() } = {}) {
  const port = def.port;
  // 档位：接入了就是 linked（失联时降级回 health / port）；有健康检查就是 health；否则 port——端口是身份
  const probe = { tier: def.link ? 'linked' : def.health ? 'health' : 'port', port };
  if (def.health) probe.health = { url: `http://127.0.0.1:${port}${def.health.path}`, timeoutMs: def.health.timeoutMs ?? 3000 };
  // 管理器自己 spawn（detaches: false）：PID 当场到手、输出进 logs/<id>.out.log、零窗口，
  // 管理器重启时它照跑、照样被认领回来（管理器重启时被收走的只是 cmd 包装层，服务是孙子进程）
  const start = def.argv ? { argv: [...def.argv] } : { cmd: def.command };
  start.detaches = false;
  start.readyTimeoutMs = def.readyTimeoutMs ?? 60000;
  const hooks = { start };
  if (def.stop) hooks.stop = { cmd: def.stop.command, timeoutMs: def.stop.timeoutMs ?? 60000 };
  const raw = {
    id: ownedIdOf(owner, name),
    name: def.title || name,
    project: def.project || ownerProject || owner,
    owner,
    root: def.cwd,
    kind: 'managed',
    probe,
    link: { enabled: !!def.link },
    hooks,
  };
  if (def.env?.length) {
    raw.env = def.env.map((e) => ({
      name: e.name, from: e.from,
      ...(e.from === 'file' ? { path: e.path } : {}),
      ...(e.from === 'literal' ? { value: String(e.value) } : {}),
      ...(e.optional ? { optional: true } : {}),
    }));
  }
  if (def.logs?.length) raw.logs = def.logs.map((l) => ({ path: l.path, ...(l.label ? { label: l.label } : {}) }));
  raw.autoRestart = { enabled: !!def.autoRestart };   // 默认关（吃显存的服务盲目重拉代价太大），登记方显式要才开
  if (prevRaw?.exposure) raw.exposure = prevRaw.exposure;
  raw.registeredAt = prevRaw?.registeredAt || now;
  raw.updatedAt = now;
  return raw;
}

// oxlint-disable-next-line no-unused-vars -- 解构出来就是为了从 rest 里去掉它们
const withoutTimes = ({ registeredAt, updatedAt, ...rest }) => rest;
/** 定义有没有变：不算登记 / 更新时间。没变就不写文件、不 reload——登记方可以放心地反复整份同步。 */
export const sameDefinition = (a, b) => JSON.stringify(withoutTimes(a || {})) === JSON.stringify(withoutTimes(b || {}));
/** 变的是不是在跑的进程关心的东西（命令、目录、环境、接入）。是的话要重启才生效，回复里告诉登记方。 */
const runtimeOf = (r) => JSON.stringify([r?.root, r?.hooks?.start, r?.link, r?.env || []]);

/** 这个端口是不是已经登记给别的服务了（探活端口、附属端口、对外端口都算）。 */
export function portHolder(services, port, exceptId = null) {
  for (const s of services.values()) {
    if (s.id === exceptId) continue;
    if (s.probe?.port === port) return { id: s.id, as: '探活端口' };
    if ((s.probe?.extraPorts || []).includes(port)) return { id: s.id, as: '附属端口 extraPorts' };
    if (s.exposure?.localPort === port) return { id: s.id, as: '对外端口 exposure.localPort' };
  }
  return null;
}

const HEADER = (owner) => [
  `# 由 ${owner} 经接入协议登记的服务（docs/link-protocol.md §7）。`,
  `# 管理器按 ${owner} 发来的定义整份重写这个文件：手改会在它下次更新时被覆盖，要长期改请让 ${owner} 改定义。`,
  '# 你照样可以在 WebUI / CLI 里启停它、开关开机自启；撤销用 `lsm owned remove <id>`。',
  '',
].join('\n');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);   // 原子替换，避免半截文件
}

/** 回复的线上格式：失败统一成 error: { code, message, details? }（docs/link-protocol.md §7）。 */
export function wireReply(r) {
  if (r.ok) return r;
  // oxlint-disable-next-line no-unused-vars -- ok 解构出来就是为了从 rest 里去掉
  const { ok, code, why, details, ...rest } = r;
  return { ...rest, ok: false, error: { code: code || 'failed', message: why || '失败', ...(details ? { details } : {}) } };
}

/** 接上一个 Supervisor。状态推送的「上次推了什么」也记在这里，按登记方分开。 */
export function createOwned(sup) {
  const locks = new Map();   // id → 排队的尾巴：同一个服务的操作一次一个，登记、启停、撤销不会交错
  const sent = new Map();    // 登记方 → Map(id → 上次推送的指纹)

  function serial(id, fn) {
    const run = (locks.get(id) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }

  const ownedBy = (owner) => [...sup.services.values()].filter((s) => s.owner === owner);
  const nameOf = (svc) => svc.id.slice(svc.owner.length + OWNED_SEP.length);

  /** 和 WebUI 一样的能力口径：接入后 stop / restart / busy 以服务自报为准，start 永远来自注册表。 */
  function capsOf(svc) {
    const link = sup.link?.status(svc.id);
    return link?.connected && link.capabilities
      ? [...new Set([...link.capabilities, ...svc.capabilities.filter((c) => c === 'start')])]
      : svc.capabilities;
  }

  /** 推给登记方的一条服务状态（字段见 docs/link-protocol.md §7）。 */
  function statusOf(svc) {
    if (!svc) return null;
    const st = sup.st(svc.id);
    return {
      id: svc.id, name: nameOf(svc), owner: svc.owner, title: svc.name, port: svc.probe.port,
      state: st.state, desired: st.desired || 'stopped', up: UP.includes(st.state),
      listening: st.listening ?? null, health: st.health ?? null,
      tier: st.tier || svc.probe.tier, pid: st.pid ?? null, since: st.runningSince ?? null,
      autostart: sup.bootList.has(svc.id), linked: !!sup.link?.status(svc.id)?.connected,
      busy: !!st.busy, busyReason: st.busyReason || null, pendingStop: !!st.pendingStop,
      capabilities: capsOf(svc),
      detail: st.detail || null, lastError: st.lastError || null,
    };
  }
  // 指纹不算 detail / since：detail 是给人看的说明（HTTP 状态文字、「第 1 次，下一轮再确认」），
  // 跟着推就行，不该单独触发推送；since 只在状态变时才变
  // oxlint-disable-next-line no-unused-vars -- 解构出来就是为了从 rest 里去掉它们
  const sigOf = ({ detail, since, ...rest }) => JSON.stringify(rest);

  /** 登记方本身得是注册表顶层的服务：名下只有一层，名下的服务不能再登记服务。 */
  function ownerCheck(owner) {
    const svc = sup.services.get(owner);
    if (!svc) return fail('not-allowed', `${owner} 不在注册表里`);
    if (svc.owner) return fail('not-allowed', `${owner} 自己就是 ${svc.owner} 名下的服务，不能再登记服务——名下只有一层`);
    return { ok: true, svc };
  }

  function target(owner, rawName, { mustExist = true } = {}) {
    const r = resolveName(owner, rawName);
    if (!r.ok) return r;
    const svc = sup.services.get(r.id);
    if (svc && svc.owner !== owner) return fail('not-owner', `${r.id} 是手写在注册表里的服务，不是 ${owner} 经协议登记的，碰不了`);
    if (!svc && mustExist) return fail('not-found', `${owner} 名下没有 ${r.name}`);
    return r;
  }

  const result = (id, r) => {
    const service = statusOf(sup.services.get(id));
    if (r.ok) return { ok: true, ...(r.already ? { already: true } : {}), ...(r.pending ? { pending: true, note: r.why } : {}), service };
    return { ...fail('failed', r.why || '失败'), service };
  };

  async function put(owner, ownerSvc, def) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return fail('bad-request', 'services.put 必须带 service（服务定义）');
    const t = target(owner, def.name, { mustExist: false });
    if (!t.ok) return t;
    return serial(t.id, async () => {
      const errs = definitionErrors(def, { managerPort: sup.manager.port });
      if (errs.length) return fail('invalid', `定义不合规：${errs.join('；')}`, errs);
      const cur = sup.services.get(t.id);
      if (cur && cur.owner !== owner) return fail('not-owner', `${t.id} 是手写在注册表里的服务，不是 ${owner} 经协议登记的，碰不了`);
      const holder = portHolder(sup.services, def.port, t.id);
      if (holder) return fail('port-conflict', `端口 ${def.port} 已经登记给 ${holder.id}（${holder.as}）——管理器不分配端口，换一个`);

      const file = path.join(OWNED_DIR, owner, `${t.name}.yaml`);
      let prevRaw = null;
      let prevText = null;
      if (cur) {
        try { prevText = fs.readFileSync(cur._file, 'utf-8'); prevRaw = YAML.parse(prevText); } catch {}
      }
      const raw = buildRaw(owner, t.name, def, { ownerProject: ownerSvc.project, prevRaw });
      // 照注册表的规矩预检：和加载注册表用的是同一个函数，写进去之后不会才发现坏了
      const verrs = [];
      validate(parseService(raw, file, owner), file, verrs);
      if (verrs.length) return fail('invalid', `定义不合规：${verrs.join('；')}`, verrs);

      const st = sup.st(t.id);
      const live = !!cur && LIVE.includes(st.state);
      // 在跑的时候改端口：新端口上没人听 → 判它挂了，老端口上那个进程从此没人认——两头都错
      if (live && cur.probe.port !== def.port) {
        return fail('running', `${t.id} 正在跑（${st.state}），端口不能在跑的时候改——先 services.stop，再登记新端口`);
      }

      const changed = !prevRaw || !sameDefinition(prevRaw, raw);
      if (changed) {
        const before = new Set(sup.registryErrors || []);
        try { writeAtomic(file, HEADER(owner) + YAML.stringify(raw, { lineWidth: 0 })); } catch (e) {
          return fail('registry', `注册表写不进去：${e.message}`);
        }
        sup.reload();
        const label = `owned/${owner}/${t.name}.yaml`;
        const fresh = (sup.registryErrors || []).filter((e) => !before.has(e) && (e.includes(label) || e.includes(t.id)));
        if (fresh.length || !sup.services.get(t.id)) {
          // 写进去才发现和别的声明冲突：撤回，注册表回到原样
          try { if (prevText != null) writeAtomic(file, prevText); else fs.rmSync(file, { force: true }); } catch {}
          sup.reload();
          return fail('invalid', `写进注册表后校验不过，已撤回：${fresh.join('；') || '加载不到'}`, fresh);
        }
        audit('owned-put', { owner, id: t.id, created: !cur, port: def.port });
        info(`${owner} ${cur ? '更新' : '登记'}了名下的服务 ${t.id}`, { port: def.port });
        sup.emit('registry-changed');
      }

      const warnings = [];
      if (def.autostart != null && sup.bootList.has(t.id) !== def.autostart) {
        const a = sup.setAutostart(t.id, def.autostart);
        if (!a.ok) warnings.push(`开机自启没设上：${a.why}`);
        else sup.emit('registry-changed');
      }
      const restartNeeded = !!(cur && changed && live && runtimeOf(prevRaw) !== runtimeOf(raw));
      return {
        ok: true, created: !cur, changed, restartNeeded,
        ...(warnings.length ? { warnings } : {}),
        service: statusOf(sup.services.get(t.id)),
      };
    });
  }

  // 停不停得了、本来是不是就停着，都由 supervisor.stop 判（看进程和端口，不看健康检查）：
  // 本来就停着的直接成功；还在跑又没有停机能力、没带 force 的，回 no-capability
  async function stop(owner, id, { force, mode }) {
    const r = await sup.stop(id, { mode, force, reason: `${owner} 经接入协议` });
    if (r.code === 'no-capability') {
      return fail('no-capability', `${id} 没有停机能力（定义里没给 stop.command，也没接入）。要停就带 force: true——直接杀进程树，正在进行的工作会丢（管理器不替它装出一个优雅停机）`);
    }
    return result(id, r);
  }

  async function restart(owner, id, { force, mode }) {
    const svc = sup.services.get(id);
    const reason = `${owner} 经接入协议`;
    // 没在跑的「重启」就是启动。在不在跑看进程和端口，不看账本上的状态——健康检查不过的服务记着 FAILED，进程却还在
    if (!(await sup.liveness(svc)).running) return result(id, await sup.start(id, { reason }));
    if (capsOf(svc).includes('restart')) return result(id, await sup.restart(id, { mode, reason }));
    if (!force) {
      return fail('no-capability', `${id} 没有重启能力（定义里没给 stop.command，也没接入）。要重启就带 force: true——先杀进程树再起（管理器不替它装出一个优雅停机）`);
    }
    const s = await sup.stop(id, { force: true, reason });
    if (!s.ok) return result(id, s);
    return result(id, await sup.start(id, { reason }));
  }

  /** 撤销前查引用：撤了会留下指向空气的依赖、隧道、tailnet 入口，注册表从此每次 reload 都报错。 */
  function usersOf(id) {
    const out = [];
    for (const s of sup.services.values()) {
      if (s.id === id) continue;
      if (s.dependsOn.some((d) => d.id === id)) out.push(`${s.id} 依赖它`);
    }
    const self = sup.services.get(id);
    if (self?.exposure?.via) out.push(`它接着公网隧道 ${self.exposure.via}（在 WebUI 上开的）`);
    if (sup.tailnetEntries?.has(id)) out.push('它有 tailnet 入口');
    return out;
  }

  /**
   * 撤销：先停（强制停止的语义），再从开机自启名单、注册表、账本里拿掉。by：谁撤的（登记方 / user）。
   * 不看账本上写的是不是 STOPPED，一律走一遍 stop：stop 会亲眼看进程和端口，真没在跑就直接返回，
   * 还在跑就停掉、确认端口空了才算——撤了登记却留一个进程占着端口，就再也没人认它了。
   */
  function withdraw(id, { by = 'user' } = {}) {
    return serial(id, async () => {
      const svc = sup.services.get(id);
      if (!svc) return fail('not-found', `没有这个服务：${id}`);
      if (!svc.owner) return fail('not-owner', `${id} 是手写在注册表里的服务，不是经协议登记的——要删就删它的 yaml`);
      const users = usersOf(id);
      if (users.length) return fail('in-use', `${id} 还被用着：${users.join('；')}——先撤掉这些再撤销`, users);

      const r = await sup.stop(id, { force: true, reason: `撤销（${by}）` });
      if (!r.ok) return { ...fail('failed', `停不下来，没撤销（登记还在，照常归管理器管）：${r.why}`), service: statusOf(svc) };
      if (sup.bootList.has(id)) {
        const a = sup.setAutostart(id, false);
        if (!a.ok) return fail('registry', `开机自启名单改不了，没撤销：${a.why}`);
      }
      try { fs.rmSync(svc._file, { force: true }); } catch (e) { return fail('registry', `删不掉 ${svc._file}：${e.message}`); }
      try { fs.rmdirSync(path.dirname(svc._file)); } catch {}   // 登记方名下空了就把目录也收掉（不空会失败，正好）
      sup.reload();
      delete sup.state.services[id];   // 账本里的旧状态一并清掉：同名重新登记时从头算
      sup.persist();
      audit('owned-remove', { owner: svc.owner, id, by });
      info(`名下的服务 ${id} 已撤销（${by === svc.owner ? '登记方自己撤的' : `由 ${by} 撤的`}）`);
      sup.emit('registry-changed');
      return { ok: true, removed: { id, name: nameOf(svc) } };
    });
  }

  /** 协议入口：一条 services.* 请求 → 回复（内部格式，线上格式见 wireReply）。 */
  async function request(owner, msg) {
    const own = ownerCheck(owner);
    if (!own.ok) return own;
    if (msg.type === 'services.list') return { ok: true, services: ownedBy(owner).map(statusOf) };
    if (msg.type === 'services.put') return put(owner, own.svc, msg.service);

    const ops = ['services.start', 'services.stop', 'services.restart', 'services.autostart', 'services.remove'];
    if (!ops.includes(msg.type)) return fail('bad-request', `不认识的消息：${msg.type}`);
    const t = target(owner, msg.name);
    if (!t.ok) return t;
    const force = msg.force === true;
    const mode = msg.mode === 'when-idle' ? 'when-idle' : 'now';
    switch (msg.type) {
      case 'services.start': return serial(t.id, async () => result(t.id, await sup.start(t.id, { reason: `${owner} 经接入协议` })));
      case 'services.stop': return serial(t.id, () => stop(owner, t.id, { force, mode }));
      case 'services.restart': return serial(t.id, () => restart(owner, t.id, { force, mode }));
      case 'services.autostart': {
        if (typeof msg.on !== 'boolean') return fail('bad-request', 'services.autostart 要带 on: true / false');
        return serial(t.id, async () => {
          const a = sup.setAutostart(t.id, msg.on);
          if (!a.ok) return fail('registry', a.why);
          sup.emit('registry-changed');
          return { ok: true, service: statusOf(sup.services.get(t.id)) };
        });
      }
      default: return withdraw(t.id, { by: owner });   // services.remove
    }
  }

  /**
   * 这个登记方该收到的状态推送：full = 全量（接入时推一次），否则只给变了的和撤掉了的。
   * 没有要推的返回 null。
   */
  function diff(owner, { full = false } = {}) {
    const now = new Map(ownedBy(owner).map((s) => [s.id, statusOf(s)]));
    const prev = full ? new Map() : (sent.get(owner) || new Map());
    if (!full && !now.size && !prev.size) return null;   // 名下从来没有服务的接入方（绝大多数）：什么都不记、不推
    const sigs = new Map();
    const changed = [];
    for (const [id, s] of now) {
      const g = sigOf(s);
      sigs.set(id, g);
      if (prev.get(id) !== g) changed.push(s);
    }
    const removed = [...prev.keys()].filter((id) => !now.has(id)).map((id) => id.slice(owner.length + OWNED_SEP.length));
    sent.set(owner, sigs);
    if (full) return { full: true, services: [...now.values()], removed: [] };
    if (!changed.length && !removed.length) return null;
    return { full: false, services: changed, removed };
  }

  return {
    request, withdraw, diff, statusOf,
    listFor: (owner) => ownedBy(owner).map(statusOf),
    /** 登记方掉线：忘掉推过什么，下次接入从全量开始 */
    forget: (owner) => { sent.delete(owner); },
  };
}
