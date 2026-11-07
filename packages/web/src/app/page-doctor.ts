// 体检（319b、409）在网页上的那一半里"碰浏览器"的那部分：取体检结果的钩子（useDoctor），深度体检那一块的钩子（useDoctorDeep，415）。
// 纯的部分（请求、总状态那几句、几种结果的叫法）在 app/doctor.ts，那边能在 Node 里直接测；分工照 app/setup.ts / app/page-setup.ts。
// 演示页也走 DaemonHttp：原型的假 HTTP 给编好的一份（prototype/fake-doctor.ts），不请求网络。
import { useCallback, useEffect, useState } from "react";
import type { DoctorDeepView, DoctorView, DoctorWatchView } from "../state/index.ts";
import { doctorDeepNow, doctorDeepWaitSeconds, loadDoctor, loadDoctorDeep, startDoctorDeep } from "./doctor.ts";
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
  /** 后台盯着那一段换成新的（"恢复提醒"之后守护进程回的），不用整份再查 */
  updateWatch(watch: DoctorWatchView): void;
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

  const updateWatch = useCallback((watch: DoctorWatchView) => setView((current) => (current === undefined ? current : { ...current, watch })), []);

  return { view, loading, error, recheck, updateWatch };
}

/** 深度体检正在测时多久取一次（毫秒） */
const DEEP_POLL_MS = 1_000;
/** 刚测过、在倒数"几秒后能再测"时多久重画一次（毫秒；只重画，不请求） */
const DEEP_COUNTDOWN_MS = 1_000;
/** 别的时候多久重画一次"几分钟前测的"（毫秒） */
const DEEP_AGO_MS = 30_000;

/** 体检页上深度体检那一块用的 */
export interface DoctorDeepState {
  /** 上一次（或正在测的这一次）；还没取到是 undefined */
  view?: DoctorDeepView | undefined;
  /** 守护进程的此刻（算"几分钟前测的"、"几秒后能再测"） */
  now: number;
  /** 正在请求开测 */
  starting: boolean;
  /** 取不到、开测没开成的原因 */
  error?: string | undefined;
  /** 点了"深度体检""再测一遍" */
  start(): void;
}

/**
 * 深度体检：打开时取上一次的（不跑）；换了语言再取（句子是守护进程按当前语言拼的）；点了开测，正在测时每秒取一次，
 * 逐项出结果；没在测时隔一会儿重画（"几分钟前测的"、"几秒后能再测"跟着走）。只在深度体检那一块里用，重画不带动整页
 */
export function useDoctorDeep(): DoctorDeepState {
  const { ui, http } = useStore();
  const online = import.meta.env.MODE === "demo" || ui.connection === "online";
  const revision = useLocale();
  const [view, setView] = useState<DoctorDeepView | undefined>();
  const [fetchedAt, setFetchedAt] = useState(0);
  const [localNow, setLocalNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const got = useCallback((next: DoctorDeepView) => {
    const at = Date.now();
    setView(next);
    setFetchedAt(at);
    setLocalNow(at);
    setError(undefined);
  }, []);

  // 打开时、换了语言时取上一次的（revision 只用来在换了语言时重取）
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- revision 只用来在换了语言时重取
  useEffect(() => {
    if (!online) return;
    let live = true;
    loadDoctorDeep(http).then(
      (next) => {
        if (live) got(next);
      },
      (err: unknown) => {
        if (live) setError(messageOf(err));
      },
    );
    return () => {
      live = false;
    };
  }, [http, online, revision, got]);

  // 正在测：每秒取一次，测完为止
  const running = view?.state === "running";
  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = setInterval(() => {
      loadDoctorDeep(http).then(
        (next) => {
          if (live) got(next);
        },
        (err: unknown) => {
          if (live) setError(messageOf(err));
        },
      );
    }, DEEP_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [http, running, got]);

  const now = view === undefined ? localNow : doctorDeepNow(view, fetchedAt, localNow);

  // 没在测：重画"几分钟前测的"（每 30 秒）、"几秒后能再测"（倒数时每秒）；只走本机的时钟，不请求
  const shown = view !== undefined && !running;
  const cooling = view !== undefined && doctorDeepWaitSeconds(view, now) > 0;
  useEffect(() => {
    if (!shown) return;
    const timer = setInterval(() => setLocalNow(Date.now()), cooling ? DEEP_COUNTDOWN_MS : DEEP_AGO_MS);
    return () => clearInterval(timer);
  }, [shown, cooling]);

  const start = useCallback(() => {
    setStarting(true);
    startDoctorDeep(http)
      .then(got, (err: unknown) => setError(messageOf(err)))
      .finally(() => setStarting(false));
  }, [http, got]);

  return { view, now, starting, error, start };
}
