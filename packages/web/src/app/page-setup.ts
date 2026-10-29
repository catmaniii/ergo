// 首次设置向导（319 号票）在网页上的那一半里"碰浏览器"的那部分：取状态的钩子（useSetup）、这个页面是不是演示页、
// 首页那条引导条在这台设备上的那一份（window.localStorage）。纯的部分在 app/setup.ts，那边能在 Node 里直接测。
// 分开写照 app/board-fold-setting.ts（纯）和 app/page-board-fold.ts（钩子）的分法：一个模块不碰浏览器的全局变量。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type SetupStepId, type SetupView } from "../state/index.ts";
import { isPrototypePage } from "./prototype-mode.ts";
import { demoMarked, demoSetupView, fetchSetup, markSetup, type SetupBannerSetting, setupBannerSettingIn } from "./setup.ts";
import { useStore } from "./store.tsx";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

let prototype: boolean | undefined;

/** 这个页面是不是演示页（直接打开构建产物 file://、在线演示页）：没有守护进程，不请求网络；Node 里（没有 window）当不是 */
export function setupPrototypePage(): boolean {
  prototype ??= typeof window !== "undefined" && isPrototypePage(window.location.protocol, import.meta.env.MODE);
  return prototype;
}

/** 向导页、首页那条引导条用的：取到的五步、在不在取、失败的原因、打标记 */
export interface SetupState {
  /** 五步的样子；还没取到（或者取不到）是 undefined */
  view?: SetupView | undefined;
  loading: boolean;
  /** 取不到、打标记没成功的原因（守护进程的原话） */
  error?: string | undefined;
  /** 标一步：skip 为真写"以后再说"，否则写"看过了 / 做完了"；成功后 view 换成打完之后的整份，失败回 undefined */
  mark(step: SetupStepId, skip: boolean): Promise<SetupView | undefined>;
}

/**
 * 打开时取一次（连上守护进程之后取：还没连上时取也是白取），之后只有打标记时换。
 * 演示页不取、不发请求：一上来就是 demoSetupView()，点了假装记下。
 */
export function useSetup(): SetupState {
  const { ui } = useStore();
  const online = ui.connection === "online";
  const demo = setupPrototypePage();
  const [view, setView] = useState<SetupView | undefined>(() => (demo ? demoSetupView() : undefined));
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | undefined>();
  /** mark 是回调，读现在的这一份（演示页里接着上一份改） */
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  });

  useEffect(() => {
    if (demo || !online) return;
    let live = true;
    fetchSetup()
      .then(
        (next) => {
          if (!live) return;
          setView(next);
          setError(undefined);
        },
        (err: unknown) => {
          if (live) setError(messageOf(err));
        },
      )
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [demo, online]);

  const mark = useCallback(
    async (step: SetupStepId, skip: boolean): Promise<SetupView | undefined> => {
      if (demo) {
        const next = demoMarked(latest.current ?? demoSetupView(), step);
        setView(next);
        return next;
      }
      try {
        const next = await markSetup(step, skip);
        setView(next);
        setError(undefined);
        return next;
      } catch (err) {
        setError(messageOf(err));
        return undefined;
      }
    },
    [demo],
  );

  return { view, loading, error, mark };
}

let bannerSetting: SetupBannerSetting | undefined;

/** 整个页面共用的一份（这台设备的 localStorage） */
export function pageSetupBanner(): SetupBannerSetting {
  bannerSetting ??= setupBannerSettingIn(() => window.localStorage);
  return bannerSetting;
}

/** 这条引导条关掉了没有，关了跟着变 */
export function useSetupBannerDismissed(): boolean {
  const setting = pageSetupBanner();
  return useSyncExternalStore(setting.subscribe, setting.dismissed);
}
