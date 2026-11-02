// 连接地址在网页上的那一半里"碰浏览器"的那部分：二维码界面用的钩子。纯的部分在 app/connection-addresses.ts。
// 服务管家的入口随时会变（用户在它那边开通了、实测结果变了）：页面开着时隔一会儿问一次守护进程，开好了二维码自己就出现。
import { useCallback, useEffect, useState } from "react";
import type { ConnectionAddressesView } from "../state/index.ts";
import { demoConnectionAddressesView, fetchConnectionAddresses, postManualAddress } from "./connection-addresses.ts";
import { useStore } from "./store.tsx";

/** 页面开着时多久问一次：只问本机的守护进程，它手里的是服务管家推来的现成结果 */
const POLL_MS = 5_000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface ConnectionAddressesState {
  /** 还没取到（或者取不到）是 undefined */
  view?: ConnectionAddressesView | undefined;
  /** 取不到的原因（守护进程的原话） */
  error?: string | undefined;
  /** 改手填的那个（null 是去掉）：成功回 undefined，失败回给人看的原因 */
  saveManual(manual: string | null): Promise<string | undefined>;
}

export function useConnectionAddresses(): ConnectionAddressesState {
  const { ui } = useStore();
  const online = ui.connection === "online";
  // 演示页不请求网络（字面的 MODE 比较：安装版这些分支摇掉，假地址不进产物）
  const [view, setView] = useState<ConnectionAddressesView | undefined>(() => (import.meta.env.MODE === "demo" ? demoConnectionAddressesView() : undefined));
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (import.meta.env.MODE === "demo" || !online) return;
    let live = true;
    const load = () =>
      fetchConnectionAddresses().then(
        (next) => {
          if (!live) return;
          setView(next);
          setError(undefined);
        },
        (err: unknown) => {
          if (live) setError(messageOf(err));
        },
      );
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [online]);

  const saveManual = useCallback(
    async (manual: string | null) => {
      if (import.meta.env.MODE === "demo") {
        setView(demoConnectionAddressesView(manual ?? undefined));
        return undefined;
      }
      try {
        setView(await postManualAddress(manual));
        return undefined;
      } catch (err) {
        return messageOf(err);
      }
    },
    [],
  );

  return { view, error, saveManual };
}
