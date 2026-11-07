// 体检（319b、409）在网页上的那一半里"碰浏览器"的那部分：取体检结果的钩子（useDoctor）。
// 纯的部分（请求、总状态那几句、几种结果的叫法）在 app/doctor.ts，那边能在 Node 里直接测；分工照 app/setup.ts / app/page-setup.ts。
// 演示页也走 DaemonHttp：原型的假 HTTP 给编好的一份（prototype/fake-doctor.ts），不请求网络。
import { useCallback, useEffect, useState } from "react";
import type { DoctorView } from "../state/index.ts";
import { loadDoctor } from "./doctor.ts";
import { useLocale } from "./locale.ts";
import { useStore } from "./store.tsx";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 体检页用的：查到的结果、在不在查、查不成的原因、再查一遍 */
export interface DoctorState {
  /** 体检结果；还没查到（或者查不到）是 undefined */
  view?: DoctorView | undefined;
  loading: boolean;
  /** 查不成的原因（守护进程的原话） */
  error?: string | undefined;
  /** 再查一遍（右上的按钮） */
  recheck(): void;
}

/**
 * 打开时查一次（连上守护进程之后查：还没连上时查也是白查）；换了语言再查一次——每项的句子是守护进程按当前语言拼的；
 * 之后只有点"再查一遍"时再查
 */
export function useDoctor(): DoctorState {
  const { ui, http } = useStore();
  // 演示页（原型的假连接不报"连上了"）不等连上：假 HTTP 直接给编好的一份（字面的 MODE 比较，安装版摇掉）
  const online = import.meta.env.MODE === "demo" || ui.connection === "online";
  const revision = useLocale();
  const [view, setView] = useState<DoctorView | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  // revision 只用来在换了语言时重取（句子是守护进程按当前语言拼的）
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- revision 只用来在换了语言时重取
  useEffect(() => {
    if (!online) return;
    let live = true;
    loadDoctor(http).then(
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
  }, [http, online, revision]);

  // 再查一遍：和打开时同一条路（重新请求 GET /api/doctor），查的时候按钮点不了、写"正在查…"
  const recheck = useCallback(() => {
    setLoading(true);
    loadDoctor(http).then(
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
  }, [http]);

  return { view, loading, error, recheck };
}
