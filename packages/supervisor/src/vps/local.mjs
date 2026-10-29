// 电脑这一半（321 号票）：隧道方式要在服务管家里登记一条 ssh 反向隧道服务；
// headscale 方式要检查 tailnet 入口没有接到 8810。
//
// 隧道服务的注册表文件由这里整份生成（文件里带一行标记，没有标记的同名文件是你手写的，不碰）。
// 钥匙路径是 Windows 路径，写进 YAML 时用双引号 + 转义（JSON 字符串就是合法的 YAML 双引号字符串）；
// 写完马上按注册表的规矩读回来核对一遍——Windows 路径进 YAML 被转义符吃坏（\v、\a 变成控制字符）踩过一次。
import fs from 'node:fs';
import path from 'node:path';
import { SERVICES_DIR, DATA_DIR } from '../paths.mjs';
import { loadServices } from '../registry.mjs';
import { exposedPort } from '../exposure.mjs';
import { loadTailnetList } from '../tailnet.mjs';
import { sshArgv } from './remote.mjs';
import { localPortProblem, ERGO_LOCAL_PORT } from './verify.mjs';
import { renameRetry } from './state.mjs';

export const MARKER = '# ergo-vps-setup: tunnel';
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 隧道服务的 ssh 命令行：受限账号、隧道钥匙、专用 known_hosts；-R 两头都只绑 127.0.0.1。 */
export function tunnelArgv(plan, keys) {
  const problem = localPortProblem(plan.localPort);
  if (problem) throw new Error(problem);
  const base = sshArgv({ ...plan.vps, user: plan.account }, keys.tunnel, keys.knownHosts, null);
  // 去掉"管理用"的几样（BatchMode 留着），加上隧道要的：不跑命令、不读 stdin、不要终端、转发失败就退出（交给 autoRestart 重连）
  const target = base.pop();
  const portIdx = base.indexOf('-p');
  const port = base.splice(portIdx, 2)[1];
  return [
    ...base, '-N', '-n', '-T', '-o', 'ExitOnForwardFailure=yes', '-p', port,
    '-R', `127.0.0.1:${plan.remotePort}:127.0.0.1:${plan.localPort}`, target,
  ];
}

const yamlStr = (s) => JSON.stringify(String(s));

export function tunnelServiceYaml(plan, keys, now = new Date()) {
  if (!SERVICE_ID.test(plan.serviceId)) throw new Error(`服务 id 不对：${plan.serviceId}`);
  const argv = tunnelArgv(plan, keys);
  return [
    `# 由服务管家（lsm vps setup tunnel）在 ${now.toISOString().slice(0, 10)} 生成：电脑上二狗的外网端口 ${plan.localPort} → ${plan.vps.host} 的 127.0.0.1:${plan.remotePort}`,
    `# → https://${plan.domain}。lsm vps remove tunnel 会停掉并删掉它；要改就重跑 lsm vps setup tunnel，别手改。`,
    MARKER,
    `id: ${plan.serviceId}`,
    `name: ${yamlStr(`二狗隧道入口（本机 ${plan.localPort} → VPS ${plan.remotePort}）`)}`,
    'project: ergo',
    `root: ${yamlStr(DATA_DIR)}`,
    'kind: managed',
    'role: tunnel        # 纯隧道：作为二狗公网入口的一部分显示',
    '',
    'probe:',
    '  # process 档：绿灯只保证 ssh 还在；通不通看 lsm vps status（从外面真打一遍）',
    '  tier: process',
    `  matchCmd: ${yamlStr(`${plan.remotePort}:127\\.0\\.0\\.1:${plan.localPort}`)}`,
    'capabilities: [start]',
    '',
    'hooks:',
    '  start:',
    '    # argv 直接起 ssh：不经 shell 包装，不冒窗口；ssh 自己不重连，重连交给 autoRestart',
    '    argv:',
    ...argv.map((a) => `      - ${yamlStr(a)}`),
    '    detaches: false',
    '    readyTimeoutMs: 20000',
    '',
    'autoRestart:',
    '  enabled: true',
    '  maxRetries: 20',
    '  backoffMs: [5000, 15000, 60000]',
    '',
    'profiles: [ergo]',
    '',
  ].join('\n');
}

export const tunnelServiceFile = (id) => path.join(SERVICES_DIR, `${id}.yaml`);

/** 这个文件是不是我们生成的（有标记）。不存在 = null。 */
export function ownsServiceFile(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/).includes(MARKER);
}

/**
 * 写隧道服务的注册表文件，写完按注册表的规矩读回来核对。
 * 同名文件是你手写的（没有标记）就不碰，报出来。
 */
export function writeTunnelService(plan, keys, now = new Date()) {
  const file = tunnelServiceFile(plan.serviceId);
  if (ownsServiceFile(file) === false) {
    return { ok: false, why: `${file} 已经有了，而且不是 lsm vps setup 生成的（大概是你手写的隧道）。换一个 --service-id，或者先把它挪走` };
  }
  const body = tunnelServiceYaml(plan, keys, now);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  fs.mkdirSync(SERVICES_DIR, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, body, 'utf-8');
  renameRetry(`${file}.tmp`, file);
  const { services, errors } = loadServices();
  const svc = services.get(plan.serviceId);
  const mine = errors.filter((e) => e.startsWith(`${plan.serviceId}.yaml`) || e.startsWith(`${plan.serviceId}:`));
  const want = tunnelArgv(plan, keys);
  const got = svc?.hooks?.start?.argv || [];
  const bad = mine.length ? mine.join('；') : JSON.stringify(got) !== JSON.stringify(want) ? `读回来的命令行和写进去的不一样：${JSON.stringify(got)}` : null;
  if (bad) {
    if (before == null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before, 'utf-8');
    return { ok: false, why: `隧道服务的登记没写对，已撤回：${bad}` };
  }
  return { ok: true, file, changed: before !== body };
}

/** 撤：只删我们生成的那份。 */
export function deleteTunnelService(id) {
  const file = tunnelServiceFile(id);
  const own = ownsServiceFile(file);
  if (own == null) return { ok: true, existed: false };
  if (!own) return { ok: false, why: `${file} 不是 lsm vps setup 生成的，没删` };
  fs.rmSync(file);
  return { ok: true, existed: true, file };
}

// ---------------------------------------------------------------- 二狗（ergo-daemon）的 exposure
// 隧道搭好后顺手给二狗的登记填上 exposure（via 指向这条隧道、公网地址、定期实测），网页上二狗那张卡下面就能看到这条隧道。
// 只追加一段带首尾标记行的 exposure（文本追加，不重写 YAML——重写会把你写的注释全吃掉）；撤的时候按标记原样拿掉。
// 已经有 exposure 段（比如你手写的那条接着 ergo-tunnel，或者只写了 localPort）一律不动，只告诉你怎么改。
export const ERGO_DAEMON_ID = 'ergo-daemon';
export const EXPOSURE_BEGIN = '# ergo-vps-setup: exposure（lsm vps setup tunnel 填的；lsm vps remove tunnel 会拿掉这一段）';
export const EXPOSURE_END = '# ergo-vps-setup: exposure end';

/** 要填的 exposure 段（不带首尾标记） */
export function exposureLines(plan) {
  return [
    'exposure:',
    `  via: ${plan.serviceId}`,
    `  remotePort: ${plan.remotePort}`,
    `  localPort: ${plan.localPort}`,
    `  publicUrl: ${yamlStr(`https://${plan.domain}/`)}`,
    '  check: true',
  ];
}

/** 文件里我们那一段的位置（首尾标记行的下标），没有就是 null */
function markedBlock(lines) {
  const b = lines.indexOf(EXPOSURE_BEGIN);
  if (b < 0) return null;
  const e = lines.indexOf(EXPOSURE_END, b + 1);
  return e < 0 ? null : { b, e };
}

const errorsOf = (errors, id) => errors.filter((e) => e.startsWith(`${id}:`) || e.startsWith(`${id}.yaml`));

/** 改完按注册表的规矩读回来：二狗的登记不能多出错误，check(svc) 要过；不行就换回原来的内容 */
function writeChecked(file, before, after, check) {
  const errsBefore = errorsOf(loadServices().errors, ERGO_DAEMON_ID);
  fs.writeFileSync(`${file}.tmp`, after, 'utf-8');
  renameRetry(`${file}.tmp`, file);
  const { services, errors } = loadServices();
  const fresh = errorsOf(errors, ERGO_DAEMON_ID).filter((e) => !errsBefore.includes(e));
  const why = fresh.length ? fresh.join('；') : check(services.get(ERGO_DAEMON_ID));
  if (!why) return null;
  fs.writeFileSync(file, before, 'utf-8');
  return why;
}

/**
 * 给二狗的登记填 exposure。返回 { status, why?, file?, lines? }：
 *  - filled：填上了（或者我们上次填的那段换成了这次的）；same：已经是这样；
 *  - conflict：已经有别的 exposure（你手写的、接着别的隧道、标了永不上公网……），没动，lines 是建议改成的样子；
 *  - no-daemon：服务管家里没有 ergo-daemon 的登记；failed：写了读回来不对，已换回原样。
 */
export function fillErgoExposure(plan) {
  const svc = loadServices().services.get(ERGO_DAEMON_ID);
  if (!svc) return { status: 'no-daemon' };
  const file = svc._file;
  const want = exposureLines(plan);
  const before = fs.readFileSync(file, 'utf-8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  const mine = markedBlock(lines);
  const ok = (s) => {
    const e = s?.exposure;
    if (e?.via !== plan.serviceId || e?.remotePort !== plan.remotePort || e?.localPort !== plan.localPort || e?.publicUrl !== `https://${plan.domain}/` || e?.check !== true) {
      return `读回来的 exposure 不对：${JSON.stringify(e ?? null)}`;
    }
    return null;
  };
  if (mine) {
    if (JSON.stringify(lines.slice(mine.b + 1, mine.e)) === JSON.stringify(want)) return { status: 'same', file };
    const after = [...lines.slice(0, mine.b + 1), ...want, ...lines.slice(mine.e)].join(eol);
    const why = writeChecked(file, before, after, ok);
    return why ? { status: 'failed', file, why } : { status: 'filled', file };
  }
  const e = svc.exposure;
  if (e) {
    if (!ok(svc)) return { status: 'same', file };
    const why = e.never ? `标了永不上公网（${e.never}）`
      : e.via ? `已经接着 ${e.via}${e.via === 'ergo-tunnel' ? '（你手写的那条隧道）' : ''}`
        : 'exposure 段已经有了（没接隧道）';
    return { status: 'conflict', file, why, lines: want };
  }
  const body = before.replace(/(\r?\n)*$/, '');
  const after = [body, '', EXPOSURE_BEGIN, ...want, EXPOSURE_END, ''].join(eol);
  const why = writeChecked(file, before, after, ok);
  return why ? { status: 'failed', file, why } : { status: 'filled', file };
}

/** 撤：只拿掉我们填的那一段（连同它前面那个空行）。返回 { removed, why? } */
export function clearErgoExposure() {
  const svc = loadServices().services.get(ERGO_DAEMON_ID);
  const file = svc?._file || path.join(SERVICES_DIR, `${ERGO_DAEMON_ID}.yaml`);
  if (!fs.existsSync(file)) return { removed: false };
  const before = fs.readFileSync(file, 'utf-8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  const mine = markedBlock(lines);
  if (!mine) return { removed: false };
  const from = mine.b > 0 && lines[mine.b - 1] === '' ? mine.b - 1 : mine.b;
  const after = [...lines.slice(0, from), ...lines.slice(mine.e + 1)].join(eol);
  const why = writeChecked(file, before, after, (s) => (s?.exposure ? `拿掉以后还读得到 exposure：${JSON.stringify(s.exposure)}` : null));
  return why ? { removed: false, why, file } : { removed: true, file };
}

/**
 * 注册表里有没有东西会把二狗的本机端口 8810 接出去：隧道服务的 -R、tailnet 入口的目标端口。
 * 有就是红灯（验收不过）。
 */
export function exposuresOf8810() {
  const out = [];
  const { services } = loadServices();
  for (const svc of services.values()) {
    const argv = svc.hooks?.start?.argv || [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '-R' && new RegExp(`:${ERGO_LOCAL_PORT}$`).test(argv[i + 1])) out.push(`${svc.id} 的隧道接的是 ${argv[i + 1]}`);
    }
  }
  const { entries } = loadTailnetList();
  for (const [id] of entries) {
    const svc = services.get(id);
    if (svc && exposedPort(svc) === ERGO_LOCAL_PORT) out.push(`tailnet 入口 ${id} 接的是 ${ERGO_LOCAL_PORT}（改 ${id} 的 exposure.localPort 为外网端口）`);
  }
  return out;
}
