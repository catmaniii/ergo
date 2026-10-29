// 语音识别的另一条接入（250 号票）：不自己拉起 Python，经 HTTP 调 LSM 托管的那条服务（`recognizer.py --serve`，
// 登记见 deploy/lsm/ergo-asr.example.yaml）。两条接入对上层是同一个接口（recognizer.ts 的 Recognizer）：
// 预热 / 208 号票的健康检查 / Debug 页 / 设置 · 语音的状态 / 语音插件都只认这个接口，一行都不用改。
// - 服务由 LSM 启停，二狗不拉起、不结束它（也不管它占的显存）；闲置多久卸载模型是那个服务自己的事，
//   所以配置里的 idleMinutes 只在 spawn 模式下有意义（这里不看）；
// - 接口（契约见 recognizer.py 开头）：POST /v1/warmup 让它开始加载模型（带上和 stdio 那一行 init 一样的
//   { primary, fallback }，所以两种模式用哪个模型还是这套配置说了算），异步加载、马上回状态；
//   GET /health 和 GET /v1/models 回同一份模型状态；POST /v1/transcribe 收 base64 的录音、回和 stdio 一样的识别结果；
// - 状态机、超时语义和 spawn 那条一样：预热是"没加载好就让它加载、等它好"（service 说加载好了之前每 POLL_MS 看一次 /health，
//   最多等 timeout.baseMs + timeout.coldStartMs，这个余量按本机实测 44–58 秒的加载留过）；一次识别最多等多久按语音时长和设备算
//   （recognizeTimeoutMs），超时就把这一代作废（状态记成出错、报一次它没了）、这次以出错结束，下次调用重新预热；
// - 208 号票的 check()：加载好、空着的先 GET /health 问一句（限时 checkTimeoutMs），答"还加载着"就算正常、马上回；
//   答不上、连不上、说模型没了就把它作废、重新预热（LSM 会在服务自己挂了之后重新拉起，这里只管等它）；
// - 连不上、服务回了结构化的错误（fatal）、预热失败都映射成 RecognizerUnavailable（重试没用，要人修），
//   识别本身出错（不是 fatal）是这一次没识别成、服务还在；
// - 180 号票的串词过滤和 spawn 那条共用（recognizer.ts 的 stripFiller），拿到的结果一样干净。
import fs from "node:fs";
import { nowIso, t, VOICE_MAX_MS, type VoiceModelState } from "@ergo/protocol";
import type { RecognizeTimeoutConfig } from "../config/config.ts";
import {
  CHECK_TIMEOUT_MS,
  type Recognizer,
  type RecognizeRequest,
  type RecognizeResult,
  type RecognizerInit,
  type RecognizerLifecycleEvent,
  type RecognizerLoaded,
  RecognizerUnavailable,
  recognizeTimeoutMs,
  stripFiller,
} from "./recognizer.ts";
import type { StripRule } from "./transcript-filter.ts";

export interface HttpRecognizerOptions {
  /** 服务的地址（不带末尾的斜杠），比如 http://127.0.0.1:8091 */
  url: string;
  /** 用哪个模型（预热时交给服务，和 spawn 模式的 init 一样） */
  init: RecognizerInit;
  /** 一次识别最多等多久（按时长和设备算，见 recognizeTimeoutMs） */
  timeout: RecognizeTimeoutConfig;
  /** 识别结果里要剔掉的模型自带串词（180 号票，编译好的规则）；不给不剔 */
  stripRules?: readonly StripRule[];
  /** check()（208 号票）问服务一句最多等多久（毫秒）；不给是 CHECK_TIMEOUT_MS */
  checkTimeoutMs?: number;
  log: (line: string) => void;
}

/** 发一条预热 / 探活 / 识别请求最多等多久（毫秒）：这些都该马上回，等不到就是服务卡住了 */
const CALL_TIMEOUT_MS = 10_000;
/** 服务在后台加载模型时，多久看一次 /health */
const POLL_MS = 500;

/** 服务回的模型状态（和 recognizer.py 的 status() 一致） */
interface ServiceStatus {
  ok?: unknown;
  loaded?: unknown;
  model?: unknown;
  device?: unknown;
  computeType?: unknown;
  loadMs?: unknown;
  fallbackReason?: unknown;
  error?: unknown;
}

/** 一次请求的结局：成了给正文，没成给原因（超时、守护进程在停、连不上、HTTP 状态码、正文看不懂） */
type CallResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; cause: "timeout" | "closed" | "unreachable" | "status" | "bad"; status?: number; body?: Record<string, unknown>; detail?: string };

export function createHttpRecognizer(options: HttpRecognizerOptions): Recognizer {
  const { url, log } = options;
  /** 这一代（一次从预热到"服务不正常"之间的使用）：加载好了在里面，没了就作废、下次重新预热 */
  let current: Generation | undefined;
  let closed = false;
  let state: VoiceModelState = { status: "waiting", since: nowIso() };
  const listeners = new Set<(state: VoiceModelState) => void>();
  const lifecycle = new Set<(event: RecognizerLifecycleEvent) => void>();
  /** 正在发的请求（close 时中止） */
  const inflight = new Set<AbortController>();
  /** 守护进程在停：等着的请求以"语音识别已停止"结束 */
  const closing = new AbortController();

  const setState = (next: Omit<VoiceModelState, "since">) => {
    if (closed) return;
    state = { ...next, since: nowIso() };
    for (const listener of listeners) listener(state);
  };
  const report = (event: RecognizerLifecycleEvent) => {
    if (closed) return;
    for (const listener of lifecycle) listener(event);
  };
  const setReady = (info: RecognizerLoaded) =>
    setState({
      status: "ready",
      model: info.model,
      device: info.device,
      computeType: info.computeType,
      loadMs: Math.max(0, Math.round(info.loadMs)),
      ...(info.fallbackReason ? { fallbackReason: info.fallbackReason } : {}),
    });

  /**
   * 这一代不能用了（加载失败、加载超时、识别超时、服务连不上、check 说它不对）：交给它的请求各自以出错结束，
   * 模型的状态记成出错、报一次它没了（加载好过的算意外没了，没加载起来的是没加载起来）。和 spawn 那条一样
   */
  const retire = (gen: Generation, err: Error) => {
    const wasCurrent = current === gen && !gen.retired;
    gen.retired = true;
    if (current === gen) current = undefined;
    if (!wasCurrent) return;
    setState({ status: "error", reason: err.message });
    report({ type: "ended", cause: gen.info ? "exited" : "load_failed", reason: err.message });
  };

  /** 发一个请求（超时、连不上、HTTP 状态码都按结局给，不抛） */
  const call = async (path: string, request: { method: "GET" | "POST"; body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<CallResult> => {
    const controller = new AbortController();
    inflight.add(controller);
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signals = [controller.signal, timeout, closing.signal, ...(request.signal ? [request.signal] : [])];
    try {
      const res = await fetch(`${url}${path}`, {
        method: request.method,
        ...(request.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) }),
        signal: AbortSignal.any(signals),
      });
      const text = await res.text();
      const body = parseJsonObject(text);
      if (!res.ok) return { ok: false, cause: "status", status: res.status, ...(body ? { body } : {}) };
      if (!body) return { ok: false, cause: "bad", detail: text.slice(0, 200) };
      return { ok: true, body };
    } catch (err) {
      if (timeout.aborted) return { ok: false, cause: "timeout" };
      // 守护进程在停（close）或者这次识别自己到点了：不当作服务没了
      if (closing.signal.aborted || request.signal?.aborted) return { ok: false, cause: "closed" };
      // 连不上（服务没开、被 LSM 停着没起来）
      return { ok: false, cause: "unreachable", detail: messageOf((err as { cause?: unknown }).cause ?? err) };
    } finally {
      inflight.delete(controller);
    }
  };

  /** 没成的一次请求 → 给用户看的错误：连不上、服务说加载不了是 RecognizerUnavailable，别的这一次没做成 */
  const failureOf = (result: Extract<CallResult, { ok: false }>, timeout: () => Error): Error => {
    if (result.cause === "closed") return new Error(t("voice.recognizer.stopped"));
    if (result.cause === "timeout") return timeout();
    if (result.cause === "unreachable") return new RecognizerUnavailable(t("voice.recognizer.lsmOff", { url, error: result.detail ?? "" }));
    // 服务回了错误：文字沿用 stdio 那套（"模型加载失败：…" / "识别出错：…"），fatal 的才是这个服务不能用了
    const detail = typeof result.body?.error === "string" ? result.body.error : "";
    if (result.body?.fatal === true) return new RecognizerUnavailable(detail || t("voice.recognizer.lsmStatus", { status: result.status ?? 0, url }));
    return new Error(detail || t("voice.recognizer.lsmStatus", { status: result.status ?? 0, url }));
  };

  /** 服务说的模型状态 → 加载好之后交出去的那份（模型没报的按配置里写的） */
  const loadedOf = (status: ServiceStatus): RecognizerLoaded => {
    const fallbackReason = textOf(status.fallbackReason);
    return {
      model: textOf(status.model) ?? options.init.primary.model,
      device: textOf(status.device) ?? options.init.primary.device,
      computeType: textOf(status.computeType) ?? options.init.primary.computeType,
      loadMs: typeof status.loadMs === "number" && Number.isFinite(status.loadMs) ? status.loadMs : 0,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  };

  /**
   * 让它加载、等它加载好（预热，45 号票）：POST /v1/warmup 一句（带设置），模型还没好就每 POLL_MS 看一次 /health，
   * 最多等 timeout.baseMs + timeout.coldStartMs（本机实测加载一次 44–58 秒）。服务说加载失败就不等了
   */
  const warmupAndWait = async (gen: Generation): Promise<RecognizerLoaded> => {
    const loadTimeoutMs = options.timeout.baseMs + options.timeout.coldStartMs;
    const seconds = Math.max(1, Math.round(loadTimeoutMs / 1000));
    const deadline = Date.now() + loadTimeoutMs;
    // 一次请求最多等多久：比上限短就按剩下的加载时间，服务卡住时不会比"加载超时"晚
    const left = () => Math.max(1, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()));
    const started = await call("/v1/warmup", { method: "POST", body: { primary: options.init.primary, fallback: options.init.fallback }, timeoutMs: left() });
    if (!started.ok) throw failureOf(started, () => new RecognizerUnavailable(t("voice.recognizer.loadTimeout", { seconds })));
    let status = started.body as ServiceStatus;
    for (;;) {
      const error = textOf(status.error);
      if (error) throw new RecognizerUnavailable(error);
      if (status.loaded === true) return loadedOf(status);
      if (closed || gen.retired) throw new Error(t("voice.recognizer.stopped"));
      if (Date.now() >= deadline) throw new RecognizerUnavailable(t("voice.recognizer.loadTimeout", { seconds }));
      await sleep(POLL_MS);
      const health = await call("/health", { method: "GET", timeoutMs: left() });
      if (!health.ok) throw failureOf(health, () => new RecognizerUnavailable(t("voice.recognizer.loadTimeout", { seconds })));
      status = health.body as ServiceStatus;
    }
  };

  /** 起一代：让它加载模型；加载的结局经 state / onLifecycle 报（和 spawn 那条拉起后马上加载一样） */
  const startGeneration = (): Generation => {
    setState({ status: "loading" });
    // loading 紧接着补上：先建出这一代才能把它交给预热（预热要知道它有没有被作废）
    const gen: Generation = { retired: false, busy: 0 } as Generation;
    current = gen;
    gen.loading = warmupAndWait(gen);
    // 没人等（真的识别先到、预热还没来问）时加载失败不算没处理的 rejection
    gen.loading.catch(() => {});
    gen.loading.then(
      (info) => {
        if (gen.retired) return;
        gen.info = info;
        if (current !== gen) return;
        setReady(info);
        report({ type: "loaded", info });
      },
      (err: unknown) => retire(gen, err instanceof Error ? err : new Error(String(err))),
    );
    return gen;
  };

  /** 拉起（已经加载好就用它）、等加载好 */
  const load = (): Promise<RecognizerLoaded> => {
    if (closed) return Promise.reject(new Error(t("voice.recognizer.stopped")));
    const gen = current && !current.retired ? current : startGeneration();
    return gen.info ? Promise.resolve(gen.info) : gen.loading;
  };

  return {
    get running() {
      return current !== undefined && !current.retired;
    },
    get state() {
      return state;
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycle.add(listener);
      return () => lifecycle.delete(listener);
    },
    load,
    async check() {
      const gen = current && !current.retired ? current : undefined;
      // 不在（没预热过、作废了）或者还在加载：让它加载、等加载好
      if (!gen?.info) return load();
      // 正给别处识别着（Debug 页、悬浮按钮）：它活着，那次识别自己的超时守着，不另外问
      if (gen.busy > 0) return gen.info;
      const timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      const answer = await call("/health", { method: "GET", timeoutMs });
      if (closed) throw new Error(t("voice.recognizer.stopped"));
      // 活着、模型还加载着：马上回（和 spawn 那条问一句就回一样，不再报一次"加载好了"）
      if (answer.ok && answer.body.loaded === true) return gen.info;
      const err = answer.ok
        ? new RecognizerUnavailable(t("voice.recognizer.lsmNotLoaded", { url }))
        : failureOf(answer, () => new RecognizerUnavailable(t("voice.recognizer.lsmNoAnswer", { seconds, url })));
      log(`语音识别服务不正常（${err.message}），重新预热`);
      retire(gen, err);
      // LSM 会在服务自己挂了之后重新拉起；这里重新预热、等它好，还不行就以 RecognizerUnavailable 结束
      return load();
    },
    transcribe(request: RecognizeRequest, audioMs = VOICE_MAX_MS) {
      if (closed) return Promise.reject(new Error(t("voice.recognizer.stopped")));
      const gen = current && !current.retired ? current : startGeneration();
      const timeoutMs = recognizeTimeoutMs(options.timeout, options.init, audioMs, gen.info?.device);
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      const deadline = Date.now() + timeoutMs;
      const timeoutError = new Error(t("voice.recognizer.timeout", { seconds }));
      const timerController = new AbortController();
      const signal = AbortSignal.any([timerController.signal, closing.signal]);
      const timer = setTimeout(() => {
        log(`语音识别超过 ${seconds} 秒没有结果，这次当失败（服务可能卡住了）`);
        retire(gen, timeoutError);
        timerController.abort(timeoutError);
      }, timeoutMs);
      timer.unref();
      gen.busy += 1;
      return (async () => {
        try {
          // 冷的（刚起、还在加载）：这次识别排在加载后面，和 spawn 那条"识别排在加载后面"一样
          await abortable(gen.loading, signal);
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            retire(gen, timeoutError);
            throw timeoutError;
          }
          const audio = await fs.promises.readFile(request.path);
          const answer = await call("/v1/transcribe", {
            method: "POST",
            body: { audio: audio.toString("base64"), ...(request.language ? { language: request.language } : {}), ...(request.initialPrompt ? { initialPrompt: request.initialPrompt } : {}) },
            timeoutMs: remaining,
            signal,
          });
          if (!answer.ok) {
            // 这次识别自己的超时（上面的计时器已经把它作废了）以超时结束；守护进程在停就说停了
            if (timerController.signal.aborted) throw reasonOf(timerController.signal);
            if (closing.signal.aborted) throw new Error(t("voice.recognizer.stopped"));
            const err = failureOf(answer, () => timeoutError);
            if (err instanceof RecognizerUnavailable) retire(gen, err);
            throw err;
          }
          const result = answer.body as unknown as RecognizeResult;
          if (typeof result.text !== "string" || !Array.isArray(result.segments)) throw new Error(t("voice.recognizer.lsmBadReply"));
          // 识别时显卡出错、退回了 CPU：模型的状态跟着变（和 spawn 那条一样）
          const info = gen.info;
          if (info && (info.model !== result.model || info.device !== result.device)) {
            gen.info = { ...info, model: result.model, device: result.device, computeType: result.computeType, ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}) };
            if (current === gen) setReady(gen.info);
          }
          return stripFiller(result, options.stripRules, log);
        } finally {
          clearTimeout(timer);
          gen.busy -= 1;
        }
      })();
    },
    async close() {
      closed = true;
      if (current) current.retired = true;
      current = undefined;
      const stopped = new Error(t("voice.recognizer.stopped"));
      closing.abort(stopped);
      for (const controller of inflight) controller.abort(stopped);
      inflight.clear();
    },
  };
}

/** 一代：从预热到"服务不正常"之间的使用 */
interface Generation {
  /** 已经加载好的（没有就是还在加载） */
  info?: RecognizerLoaded;
  /** 加载的结局（预热和等加载好） */
  loading: Promise<RecognizerLoaded>;
  /** 作废了（出错、超时、服务没了）：不再交给它请求 */
  retired: boolean;
  /** 正在识别几条（check 不另外问） */
  busy: number;
}

/** 等 p 有结局；signal 中止了就不等了（以 signal.reason 结束） */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(reasonOf(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reasonOf(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const reasonOf = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** 正文是个 JSON 对象时给出来（不是就 undefined：服务回半截、后面那截是网页的错误页之类） */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const textOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
