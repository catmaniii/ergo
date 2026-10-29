// 配对页的流程（137 号票）：新设备这一侧的状态和动作，页面（pages/PairingPages.tsx 的 PairingWait）只管画和计时。
// - open：打开页面只问"这台设备有没有配对请求"（刷新了页面就接着等那一个），**不发请求**——
//   公网上的扫描程序用无界面的 Chrome 打开页面、不点按钮，就不会在待我处理里冒出配对请求；
// - request：用户点了"请求配对"才发，带着说明页上的设备名；同时只发一个（连点两下也是一个）；
// - poll：等批准时页面每隔两秒问一次（批准了的那一次就领到凭证）；过期、被拒了也只是把状态换过来，**不自动重发**，
//   页面回到说明页，要再点一次；
// - rename：等批准时改设备名（本机待我处理里那张配对请求卡跟着改）。
// 现在是哪一页由状态层的 pairingStage 按请求和时间算。配对接口的形状（PairingApi）也在这里：经 HTTP 的一份在
// app/pairing-api.ts，原型预览的假的一份在 prototype/preview-pairing.ts。
import type { PairingRequestView } from "../state/index.ts";

/** 新设备这一侧的配对接口 */
export interface PairingApi {
  /** 这台设备现在的配对请求；还没有是 undefined */
  current(): Promise<PairingRequestView | undefined>;
  /** 发起配对请求；设备名不给就由守护进程按 User-Agent 生成 */
  create(deviceName?: string): Promise<PairingRequestView>;
  rename(deviceName: string): Promise<PairingRequestView>;
  /** 只有原型的预览有：模拟"在别处批准了" */
  simulateApproval?: () => void;
}

/** 配对接口回的错误（太频繁、名字不对、请求已经不在等批准了……），message 给人看 */
export class PairingError extends Error {}

export interface PairingFlowState {
  /** 问过这台设备有没有配对请求了（问到之前"请求配对"灰着，免得刷新页面时又多发一个） */
  loaded: boolean;
  /** 这台设备最近的配对请求；还没有是 undefined。过期、被拒的留着：说明页上说一句，设备名沿用它的 */
  request?: PairingRequestView;
  /** 正在发请求 */
  busy: boolean;
  /** 给人看的出错原因（太频繁、名字不对、网断了……） */
  error?: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class PairingFlow {
  private state: PairingFlowState = { loaded: false, busy: false };
  private readonly listeners = new Set<() => void>();
  private readonly api: PairingApi;

  constructor(api: PairingApi) {
    this.api = api;
  }

  /** 给 useSyncExternalStore：状态没变时是同一个对象 */
  readonly getState = (): PairingFlowState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 打开页面：已经有请求（刷新了页面）就接着等它；没有就停在说明页。问不到也让用户能点"请求配对" */
  async open(): Promise<void> {
    try {
      this.set({ loaded: true, request: await this.api.current() });
    } catch (err) {
      this.set({ loaded: true, error: errorText(err) });
    }
  }

  /** 用户点了"请求配对" */
  async request(deviceName: string | undefined): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: true, error: undefined });
    try {
      this.set({ busy: false, request: await this.api.create(deviceName) });
    } catch (err) {
      this.set({ busy: false, error: errorText(err) });
    }
  }

  /** 等批准时问一次（网断了：不报错，下一次再问） */
  async poll(): Promise<void> {
    try {
      this.set({ request: await this.api.current() });
    } catch {
      // 下一次再问
    }
  }

  /** 改设备名；没改成时写原因，回报 false（页面把输入框换回原来的名字） */
  async rename(deviceName: string): Promise<boolean> {
    try {
      this.set({ error: undefined, request: await this.api.rename(deviceName) });
      return true;
    } catch (err) {
      this.set({ error: errorText(err) });
      return false;
    }
  }

  /** 页面上的提示（设备名不能为空……） */
  setError(error: string | undefined): void {
    this.set({ error });
  }

  private set(patch: Partial<PairingFlowState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
