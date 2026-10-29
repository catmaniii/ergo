// 首次设置向导（319 号票，用户 2026-10-27 定："只做网页前端，不做终端 ergo onboard"）在网页上的这一半里"不碰浏览器"的那部分：
// 取五步各自做完了没有（GET /api/setup）、标一步"以后再说"或者"看过了 / 做完了"（POST /api/setup），
// 页面要的"现在该显示哪一步""打完这一步换到哪一步""做完了几步"，演示页的假状态，以及首页那条引导条在这台设备上的记号。
// 五步是哪五步、形状是什么在共享协议包的 setup.ts；真相是守护进程（数据目录配置文件的 setup 节），这边一个字节也不存。
// 这些函数都不碰 window、不引 React（Node 里直接查，test/app/setup.test.ts）：钩子、演示页判断、
// 页面上的那一份存储（window.localStorage）在 app/page-setup.ts（写法照 app/board-fold-setting.ts 和 app/page-board-fold.ts 的分法）。
import { HTTP_PATHS, type HttpErrorBody, SETUP_STEPS, type SetupMarkBody, type SetupStepId, type SetupStepView, type SetupView, t } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/**
 * 请求体的写法（POST /api/setup）：skip 为真写"以后再说"，为假写"看过了 / 做完了"（守护进程照 skip 是不是 true 判）。
 * 页面上两个按钮各给一个 choice，按钮那一下就调这一份，测试也查这一份
 */
export function setupMarkBody(step: SetupStepId, skip: boolean): SetupMarkBody {
  return { step, skip };
}

/** 取五步现在都做完了没有（GET /api/setup），回整份 SetupView */
export async function fetchSetup(): Promise<SetupView> {
  const res = await fetch(HTTP_PATHS.setup, { credentials: "same-origin" });
  if (!res.ok) {
    const error = (await res.json().catch(() => undefined)) as HttpErrorBody | undefined;
    throw new Error(error?.message ?? t("setup.requestFailed", { status: res.status }));
  }
  return (await res.json()) as SetupView;
}

/** 标一步（POST /api/setup），回打完标记之后的整份 SetupView */
export async function markSetup(step: SetupStepId, skip: boolean): Promise<SetupView> {
  const res = await fetch(HTTP_PATHS.setup, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(setupMarkBody(step, skip)),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => undefined)) as HttpErrorBody | undefined;
    throw new Error(error?.message ?? t("setup.requestFailed", { status: res.status }));
  }
  return (await res.json()) as SetupView;
}

/** 做完了几步（含"以后再说"的） */
export function setupDoneCount(view: SetupView): number {
  return view.steps.filter((step) => step.done).length;
}

/** 五步里的某一步；不认得的 id（老的数据、新加又撤掉的）是 undefined */
export function setupStep(view: SetupView, id: SetupStepId): SetupStepView | undefined {
  return view.steps.find((step) => step.id === id);
}

/** 现在该走哪一步：第一个还没做完的；五步都做完是 undefined（页面写"设置完了"） */
export function setupCurrentStep(view: SetupView): SetupStepView | undefined {
  return view.steps.find((step) => !step.done);
}

/**
 * 打完这一步之后接着显示哪一步：从它的下一步起往后找第一个还没做完的；
 * 后面都做完了是 undefined（页面回到"第一个还没做完的"，都完了就是"设置完了"）
 */
export function setupStepAfter(view: SetupView, id: SetupStepId): SetupStepView | undefined {
  const at = view.steps.findIndex((step) => step.id === id);
  return at < 0 ? undefined : view.steps.slice(at + 1).find((step) => !step.done);
}

/** 向导页现在显示哪一屏：选的那一步（点了也能回头看）、外网访问那一页，或者全做完了的"设置完了" */
export type SetupScreen = { kind: "step"; id: SetupStepId } | { kind: "external" } | { kind: "done" };

/**
 * 现在显示哪一屏：at 是用户点了左边 / 上面某一项（还没点过是 undefined）。
 * 点了某一步就显示那一步（做完了的也点得回去看）；点了外网访问就显示那一页；
 * 没点过（或者点的那一步不认得）就显示第一个还没做完的，五步都做完是"设置完了"
 */
export function setupScreenOf(view: SetupView, at: SetupStepId | "external" | undefined): SetupScreen {
  if (at === "external") return { kind: "external" };
  if (at !== undefined && setupStep(view, at) !== undefined) return { kind: "step", id: at };
  const current = setupCurrentStep(view);
  return current ? { kind: "step", id: current.id } : { kind: "done" };
}

/** 演示页的假状态：五步都还没做、一个条件都不满足（和守护进程里"什么都没做"的老数据目录一样） */
export function demoSetupView(): SetupView {
  return { steps: SETUP_STEPS.map((id) => ({ id, done: false, ready: false, optional: true })), complete: false };
}

/** 演示页里打标记：那一步算做完（不请求网络、也不记），回打完之后的整份 */
export function demoMarked(view: SetupView, id: SetupStepId): SetupView {
  const steps = view.steps.map((step) => (step.id === id ? { ...step, done: true } : step));
  return { steps, complete: steps.every((step) => step.done) };
}

/** 首页顶上那条"花两分钟配一下"关掉了没有，记在这台设备的哪个键上（319 号票） */
export const SETUP_BANNER_KEY = "ergo-setup-banner-dismissed";

export interface SetupBannerSetting {
  /** 关掉过（这台设备） */
  dismissed(): boolean;
  /** 点右上的 ×：收起，并记在这台设备上 */
  dismiss(): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/**
 * 接上一种存储（写法照 app/board-fold-setting.ts 的 foldSettingIn：存储用不了时按没关过，关了这次打开里照样收起）。
 * 关掉之后一直记着：这台设备上以后都不再出现（清掉站点数据才会回来）
 */
export function setupBannerSettingIn(storage: () => DeviceStorage): SetupBannerSetting {
  let dismissed: boolean;
  try {
    dismissed = storage().getItem(SETUP_BANNER_KEY) !== null;
  } catch {
    dismissed = false;
  }
  const listeners = new Set<() => void>();
  return {
    dismissed: () => dismissed,
    dismiss() {
      if (dismissed) return;
      dismissed = true;
      try {
        storage().setItem(SETUP_BANNER_KEY, "1");
      } catch {
        // 存不了：这次打开里照样收起，下次打开还会出现
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
