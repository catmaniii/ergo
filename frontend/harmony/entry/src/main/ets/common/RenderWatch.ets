// 不 import 任何东西（日志、网页框的几个动作都由 Index.ets 交进来）：frontend/test/harmony.test.ts 把整个文件拿去单测

/** 回到前台后等一下再探（ArkWeb 先把网页恢复过来） */
export const PROBE_DELAY_MS = 800;
/** 探一句 JS 多久没回算网页框坏了 */
export const PROBE_TIMEOUT_MS = 4000;
/**
 * 结束了渲染进程之后，等"网页进程没了"的回调最多这么久，到点不等了直接重载。
 * 渲染进程已经没了的，ArkWeb 也回"结束了"（日志里是 sent to detached frame will be ignored），回调不会来，所以别等太久
 */
export const EXIT_WAIT_MS = 1500;
/** 重载、重建之后多久还没加载完，就再探一次 */
export const VERIFY_MS = 15000;
/** 系统报"网页进程没响应"之后再宽限这么久，期间又响应了就不管 */
export const NOT_RESPONDING_GRACE_MS = 5000;
/** 回到前台一次最多救几回（重载一次、重建两次），救不回来就停，不来回折腾 */
export const MAX_ATTEMPTS = 3;

/**
 * 看着一个网页框的渲染进程（票 389）。
 *
 * 用户日常那台鸿蒙手机上抓到的现场：二狗在后台放久了，系统把 ArkWeb 的渲染进程（com.catmaniii.ergo:render）收掉了，
 * App 进程还在、主线程闲着，网页框停在最后一帧，点了只到 ArkWeb 的浏览器那一层（"render process has not init"），
 * 没有人重新加载，只能杀掉 App 重开。这里补上：
 * - 渲染进程没了（onRenderExited）：在前台马上重载；在后台记下，回到前台再重载；
 * - 渲染进程没响应（onRenderProcessNotResponding，只接主网页）：宽限几秒还没缓过来，结束它再重载
 *   （模拟器上试过：网页死循环卡住的渲染进程，terminateRenderProcess 回成功但进程还在，救不回来，只是多记几行日志）；
 * - 回到前台自检（只有给了 probe 的，主网页）：跑一句 JS，几秒没回就按坏了处理——系统没报回调的也救得回来
 *   （模拟器上不接回调、在后台把渲染进程弄崩，回前台的日志和用户手机上的一样：render process has not init，自检几秒后重载救回）；
 * - 救的办法一步比一步重：先结束渲染进程（已经没了就跳过）再重载这一页，还不行就重建整个网页框（主网页就是重新打开二狗的地址），
 *   每回前台最多 MAX_ATTEMPTS 回；重载完加载好了（onPageEnd、出错页也算）就算救回来了。
 */
export class RenderWatch {
  private readonly name: string;
  private readonly log: (text: string) => void;
  /** 跑一句 JS；网页框还没接上、探不了就回 undefined（不算坏） */
  private readonly probe: () => Promise<string> | undefined;
  /** 重载这一页；做不了（网页框没接上）回 false，就改成重建 */
  private readonly refresh: () => boolean;
  /** 重建整个网页框 */
  private readonly rebuild: () => void;
  /** 结束渲染进程；本来就没起来、已经没了回 false */
  private readonly terminate: () => boolean;

  private foreground: boolean = true;
  /** 加载完过一次才探（刚打开、还在头一回加载的不探，免得把正常的开场当成坏了） */
  private ready: boolean = false;
  /** 在后台时渲染进程没了：回到前台再救 */
  private gone: boolean = false;
  private attempts: number = 0;
  /** 结束了渲染进程，等它的回调再做的那一步（'' 是没在等） */
  private pendingStep: string = '';
  private verifying: boolean = false;
  /** 每次探、切前后台、页面重新开始都换一代，旧的探测回来就不认了 */
  private generation: number = 0;
  private probeTimer: number = -1;
  private exitTimer: number = -1;
  private verifyTimer: number = -1;
  private graceTimer: number = -1;

  constructor(name: string, log: (text: string) => void, probe: () => Promise<string> | undefined,
    refresh: () => boolean, rebuild: () => void, terminate: () => boolean) {
    this.name = name;
    this.log = log;
    this.probe = probe;
    this.refresh = refresh;
    this.rebuild = rebuild;
    this.terminate = terminate;
  }

  /** 回到前台（onPageShow） */
  shown(): void {
    this.foreground = true;
    this.attempts = 0;
    this.generation += 1;
    if (this.gone) {
      this.gone = false;
      this.recover('render process exited while in background', true);
      return;
    }
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => this.check('back in foreground'), PROBE_DELAY_MS);
  }

  /** 退到后台（onPageHide）：在后台不探（App 被挂起，探了也不回），正在等的验收也不等了，回前台重新探 */
  hidden(): void {
    this.foreground = false;
    this.generation += 1;
    clearTimeout(this.probeTimer);
    clearTimeout(this.verifyTimer);
    clearTimeout(this.graceTimer);
    this.graceTimer = -1;
    this.verifying = false;
  }

  /** onPageBegin：页面自己在重新加载，正在探的不认了（加载到一半的也照样探：渲染进程死在半路时 onPageEnd 永远不来） */
  pageBegin(): void {
    this.generation += 1;
  }

  /** onPageEnd，或者主框架加载出错（出错页也是渲染进程画的）：加载完了；在等验收的就算救回来了 */
  pageEnd(): void {
    this.ready = true;
    if (this.verifying) {
      this.verifying = false;
      clearTimeout(this.verifyTimer);
      this.attempts = 0;
      this.log(`${this.name} web: recovered`);
    }
  }

  /** onRenderExited：reason 是 RenderExitReason 的数字 */
  exited(reason: number): void {
    this.log(`${this.name} web: render process exited, reason ${reason}`);
    if (this.pendingStep.length > 0) {
      // 是这边结束的，接着做等着的那一步
      clearTimeout(this.exitTimer);
      this.act();
      return;
    }
    if (!this.foreground) {
      this.gone = true;
      return;
    }
    this.recover('render process exited', true);
  }

  /** onRenderProcessNotResponding：宽限一会儿，还没缓过来就救 */
  notResponding(detail: string): void {
    this.log(`${this.name} web: render process not responding (${detail})`);
    if (!this.foreground || this.graceTimer !== -1) {
      return;
    }
    this.graceTimer = setTimeout(() => {
      this.graceTimer = -1;
      this.recover('render process still not responding');
    }, NOT_RESPONDING_GRACE_MS);
  }

  /** onRenderProcessResponding：缓过来了 */
  responding(): void {
    this.log(`${this.name} web: render process responding again`);
    clearTimeout(this.graceTimer);
    this.graceTimer = -1;
  }

  /** 跑一句 JS 看网页框还活着没有 */
  private check(why: string): void {
    if (!this.foreground || !this.ready || this.verifying || this.pendingStep.length > 0) {
      return;
    }
    const pending = this.probe();
    if (pending === undefined) {
      return;
    }
    this.generation += 1;
    const generation = this.generation;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (generation === this.generation) {
          this.recover(`${why}: page did not answer in ${PROBE_TIMEOUT_MS} ms`);
        }
      }
    }, PROBE_TIMEOUT_MS);
    pending.then(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
    }).catch((err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (generation === this.generation) {
          this.recover(`${why}: page did not answer (${err.message})`);
        }
      }
    });
  }

  /** 救一回：先结束渲染进程（卡住的要先结束；已经报了没了的 gone 跳过），等它的回调再重载；第二回起重建整个网页框 */
  private recover(why: string, gone: boolean = false): void {
    if (this.pendingStep.length > 0) {
      return;
    }
    clearTimeout(this.verifyTimer);
    this.verifying = false;
    if (this.attempts >= MAX_ATTEMPTS) {
      this.log(`${this.name} web: ${why}; gave up after ${MAX_ATTEMPTS} tries`);
      return;
    }
    this.attempts += 1;
    this.pendingStep = this.attempts === 1 ? 'refresh' : 'rebuild';
    const terminated = !gone && this.terminate();
    this.log(`${this.name} web: ${why}; try ${this.attempts}: ${this.pendingStep}${terminated ? ' after ending the render process' : ''}`);
    if (terminated) {
      this.exitTimer = setTimeout(() => this.act(), EXIT_WAIT_MS);
    } else {
      this.act();
    }
  }

  private act(): void {
    const step = this.pendingStep;
    this.pendingStep = '';
    if (step.length === 0) {
      return;
    }
    this.generation += 1;
    if (step === 'rebuild' || !this.refresh()) {
      this.rebuild();
    }
    this.verifying = true;
    clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => {
      if (this.verifying) {
        this.verifying = false;
        this.check('after reload');
      }
    }, VERIFY_MS);
  }
}
