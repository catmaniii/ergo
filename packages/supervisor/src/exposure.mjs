// 公网暴露：每个服务是「仅本地」还是「也在公网上」，以及那条路现在到底通不通。
//
// 这补上了 process 档最大的盲点：隧道进程活着 ≠ 隧道通着（没有端口的服务只能看进程在不在，这是早就知道的坑）。
// 隧道的绿灯只保证 ssh 进程在跑；真正能证明公网可达的，只有从外面把那个 URL 打一遍。
import { info } from './log.mjs';

const CHECK_TIMEOUT_MS = 10000;

/**
 * 能不能给这个服务开通公网；不能的话为什么。
 * WebUI 上「开通公网」按钮的有无、createExposure 的拒绝理由都从这里取——两边说法永远一致，
 * 也意味着禁令同时拦在界面和 API 两层：就算有人绕过界面直接 POST expose-create，也开不出来。
 */
export function exposureCreatable(svc, vps) {
  // exposure.never：用户明确定过「永不上公网」的服务（比如只给本机用的推理引擎）。
  // 之前只靠「注册表里刻意不写 exposure」来表达这个意思，可那只是**没开**，不是**不许开**——
  // WebUI 照样给它一个「开通公网」按钮，点一下就破了规矩（2026-10-05 改版时发现）。
  if (svc.exposure?.never) return { ok: false, why: `${svc.id} 永不上公网：${svc.exposure.never}` };
  if (!svc.probe?.port) return { ok: false, why: `${svc.id} 没有端口，做不了端口转发` };
  if (svc.exposure?.via) return { ok: false, why: `${svc.id} 已经有公网入口（经 ${svc.exposure.via}）` };
  // exposure 段已经在（比如只写了 localPort）却没接隧道：自动追加会写出第二个 exposure 键，YAML 直接坏掉
  if (svc.exposure) return { ok: false, why: `${svc.id} 的 exposure 段已经存在，请直接编辑它的 yaml 接隧道` };
  if (!vps?.host || !vps?.key) return { ok: false, why: 'registry/manager.yaml 里还没配 vps.host / vps.key' };
  return { ok: true, why: null };
}

/** 注册表里 exposure 段的自检。单独导出是为了能直接测。 */
export function exposureErrors(e) {
  if (!e) return [];
  const errors = [];
  // localPort：隧道连的是本机哪个端口，不写就是 probe.port。
  // 2026-10-08 加：有的服务本机端口对本机来的请求自动信任，对外必须走另一个每次都要凭证的端口。
  // 「对外端口 = 探活端口」的假设让 WebUI 上点「开通公网」直接生成了一条 VPS → 本机端口的隧道——差点把一个不用鉴权的服务放上公网。
  if (e.localPort != null && !(Number.isInteger(e.localPort) && e.localPort > 0 && e.localPort < 65536)) {
    errors.push('exposure.localPort 必须是端口号（整数）');
  }
  if (e.never == null) return errors;
  if (typeof e.never !== 'string' || !e.never.trim()) {
    return [...errors, 'exposure.never 必须写明原因（字符串）——不写原因的禁令，迟早会被人当成多余的删掉'];
  }
  if (e.via) return [...errors, 'exposure.never 与 exposure.via 矛盾：一边说永不上公网，一边已经接了隧道'];
  return errors;
}

/** 隧道该连的本机端口：exposure.localPort，没写就是探活端口。 */
export function exposedPort(svc) {
  return svc.exposure?.localPort ?? svc.probe?.port ?? null;
}

export function exposureOf(svc) {
  const e = svc.exposure;
  if (!e || !e.via) return { scope: 'local' };
  return {
    scope: 'public', via: e.via, remotePort: e.remotePort ?? null, localPort: exposedPort(svc),
    publicUrl: e.publicUrl ?? null, check: e.check !== false,
  };
}

/**
 * 真的去访问一遍公网入口。401/403 一样算「通」——它证明请求穿过隧道到达了服务，
 * 只是没带口令；这正是带口令的站点在公网上的正常反应。
 */
export async function checkPublic(url) {
  const started = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    // **必须消费掉 body，否则这一行会把整个管理器打死。**
    // 只看 status、不读 body 时，undici 的 socket 被丢在半路，它的解析器在收尾时
    // 命中 `assert(!this.paused)` —— 那是**异步抛出的断言，外面这层 try/catch 包不住**，
    // 于是变成 uncaughtException，管理器进程直接退出。
    // 2026-09-03 实测：管理器起来 64 秒，日志最后一行正是
    //   「公网可达性变化 some-dashboard: 不通 → 通 {status:200}」
    // 紧接着就是 AssertionError（Node 22.23.0，node:internal/deps/undici）。
    // 后果是全机器的：管理器不常驻 → `lsm start` 退回本地直连模式 → 子进程挂在
    // 临时 shell 上、命令一返回就被回收 → **六条隧道全体反复掉线**，
    // 而 autoRestart 需要守护进程才生效，所以它一次都没救过场。
    await r.body?.cancel().catch(() => {});
    return { ok: r.status < 500, status: r.status, ms: Date.now() - started, checkedAt: Date.now() };
  } catch (e) {
    return {
      ok: false, status: null, ms: Date.now() - started, checkedAt: Date.now(),
      why: e.name === 'TimeoutError' ? '超时' : (e.cause?.code || e.message),
    };
  }
}

/** 给所有声明了公网入口、且带 URL 的服务跑一轮实测。慢周期调用，不要塞进 5 秒探活。 */
export async function checkAll(sup) {
  const out = new Map();
  const jobs = [];
  for (const svc of sup.services.values()) {
    const e = exposureOf(svc);
    if (e.scope !== 'public' || !e.publicUrl || !e.check) continue;
    jobs.push(checkPublic(e.publicUrl).then((r) => {
      const prev = sup.exposureChecks?.get(svc.id);
      if (prev && prev.ok !== r.ok) {
        info(`公网可达性变化 ${svc.id}: ${prev.ok ? '通 → 不通' : '不通 → 通'}`, { url: e.publicUrl, status: r.status, why: r.why });
      }
      out.set(svc.id, r);
    }));
  }
  await Promise.all(jobs);
  return out;
}
