// 体检（319 号票的 319b）在网页上的那一半里"碰浏览器"的那部分：取八项检查的钩子（useDoctor）、这个页面是不是演示页。
// 纯的部分（请求、演示页的假数据、事实拼句）在 app/doctor.ts，那边能在 Node 里直接测；分工照 app/setup.ts / app/page-setup.ts。
import { useCallback, useEffect, useState } from "react";
import type { DoctorView } from "../state/index.ts";
import { demoDoctorView, loadDoctor } from "./doctor.ts";
import { isPrototypePage } from "./prototype-mode.ts";
import { useStore } from "./store.tsx";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

let prototype: boolean | undefined;

/** 这个页面是不是演示页（直接打开构建产物 file://、在线演示页）：没有守护进程，不请求网络；Node 里（没有 window）当不是 */
export function doctorPrototypePage(): boolean {
  prototype ??= typeof window !== "undefined" && isPrototypePage(window.location.protocol, import.meta.env.MODE);
  return prototype;
}

/** 体检页用的：查到的八项、在不在查、查不成的原因、再查一遍 */
export interface DoctorState {
  /** 八项的样子；还没查到（或者查不到）是 undefined */
  view?: DoctorView | undefined;
  loading: boolean;
  /** 查不成的原因（守护进程的原话） */
  error?: string | undefined;
  /** 再查一遍（右上的按钮）；演示页里就是再拿一份编好的数据 */
  recheck(): void;
}

/**
 * 打开时查一次（连上守护进程之后查：还没连上时查也是白查），之后只有点"再查一遍"时再查。
 * 演示页不请求网络：一上来就是 demoDoctorView()。
 */
export function useDoctor(): DoctorState {
  const { ui } = useStore();
  const online = ui.connection === "online";
  const demo = doctorPrototypePage();
  const [view, setView] = useState<DoctorView | undefined>(() => (demo ? demoDoctorView() : undefined));
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // 还没连上守护进程时不查；演示页一上来就有假数据，不用再查一遍
    if (demo || !online) return;
    let live = true;
    loadDoctor(demo).then(
      (next) => {
        if (!live) return;
        setView(next);
        setError(undefined);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(messageOf(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [demo, online]);

  // 再查一遍：和打开时同一条路（重新请求 GET /api/doctor），查的时候按钮点不了、写"正在查…"
  const recheck = useCallback(() => {
    setLoading(true);
    loadDoctor(demo).then(
      (next) => {
        setView(next);
        setError(undefined);
        setLoading(false);
      },
      (err: unknown) => {
        setError(messageOf(err));
        setLoading(false);
      },
    );
  }, [demo]);

  return { view, loading, error, recheck };
}
