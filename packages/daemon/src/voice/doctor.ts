// 语音插件自己的体检项（413）：设置 · 体检上"语音"那一块，插件在 setup 里经 ctx.doctor.register 登记这五项（plugin.ts）。
// 2026-11-07 15:42 起语音合成服务（audio.cpp，127.0.0.1:8090）停了，语音回复都没合成出来，体检却全绿——这几项补上这个洞。
//
// 先看用户开没开（没开的"不适用"，不拉低总状态）：
// - 语音回复开着：组件页的"用语音回复"能用（语音合成装在这儿，或者别处已经有了），或者服务管家里有一条服务登记在合成服务的端口上。
//   后一条是给手工登记的 audio.cpp 的：它停着时组件页认不出它（组件那边按"端口上有人在听"认用户自己配的），这时更要报红；
// - 语音输入开着：组件页的"按住说话"能用（识别模型装在这儿，或者配了自己的识别：服务管家托管的、audio.cpp 的、自己拉起的 Python）。
//
// 五项：
// 1. 语音合成：读预热（warmup.ts）每 probeMs（默认 60 秒）探一次 /health 得来的状态；太久没看过（超过两个探活间隔）、还没看过
//    就当场探一次本机端口（1.5 秒）。连不上、试合成出错 → 坏了（修法："到服务管家把 X 开起来"，X 是服务管家里登记在这个端口的那条，
//    组件装的是 ergo-daemon--audiocpp，手工登记的是用户起的名字；带"去看看"跳服务管家的网页——418 做好后换成"开起来"）；
//    忙（显卡在给别的程序用）→ 注意。
// 2. 语音识别：读识别现成的状态，三种来源各按各的——自己拉起的 Python 只看状态（没有端口）；服务管家托管的（8091）、audio.cpp 的
//    Fun-ASR 两种，状态是刚变的（RECOGNIZER_FRESH_MS 以内）就照它，不新就当场探一次本机端口的 /health。用不了 → 坏了。
// 3. 参考音色：一条都没有 → 注意（语音回复合成不了）。
// 4. ffmpeg：PATH 上找不到 → 注意（参考音色只能导入 WAV；audio.cpp 识别收到不是 WAV 的录音会失败）。
// 5. N 卡：有是正常；没有是"提示"——体检没有单独的提示一级，照 409 落成不适用，句子写"合成、识别会很慢"。
// 语音完全没开（回复、输入都没开）时 ffmpeg、N 卡也不适用。
// 刚起来的头一分钟（VOICE_STARTUP_GRACE_MS，437）：合成、识别探不通算"没查出来"，不报坏了——刚重启时事件循环忙，
// 2026-11-08 重启后 20 秒那一眼报了"连不上 127.0.0.1:8090（1.5 秒没回应）"，一分钟后再查就好了。探的限时也只数事件循环给了的时间。
//
// 平时体检的规矩：只读状态、不改任何东西（当场探的结果不写回预热的状态）；只连本机（地址不是本机的不探，照状态说）。
// 句子是文案键 + 参数（键在 voice.json 的 voice.doctor.*），参数里的小句、时间先按当前语言拼好（体检每次现查，换了语言重新拼）。
import fs from "node:fs";
import { COMPONENT_FEATURES, type DoctorAction, type DoctorMessage, doctorServiceRoute, t, type VoiceModelState } from "@ergo/protocol";
import { findOnPath } from "../components/probes.ts";
import type { RecognizeMode } from "../config/config.ts";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import { loopTimeoutSignal } from "../util/loop-time.ts";
import type { RegisteredService } from "../lsm/registered.ts";
import type { VoiceSetup } from "../plugins/kernel.ts";

/** 当场探一次本机端口最多等多久（毫秒） */
export const VOICE_PROBE_TIMEOUT_MS = 1_500;

/** 会当场探端口的两项最多等多久（毫秒）：比探的那一下多留一点，探超时了自己报"没回应"，不算体检没查出来 */
export const VOICE_PROBE_CHECK_TIMEOUT_MS = 2_500;

/** 识别的状态是这么久以内变的才算新的（毫秒）：再旧的、又是服务那两种，当场探一次 */
export const RECOGNIZER_FRESH_MS = 2 * 60_000;

/**
 * 语音插件起来后这么久以内（毫秒）合成、识别探不通算"没查出来"，不报坏了（437）：刚启动时事件循环忙、服务管家可能也在一起拉起服务，
 * 这一眼不作数；过了这段照常报。后台盯着（416）头 5 分钟本来就不查，这条只管页面上、秘书现查的那一眼
 */
export const VOICE_STARTUP_GRACE_MS = 60_000;

/** 当场探一次 /health 的结局：连得上（带回的 JSON，识别服务的那份说模型加载没有）、连不上（原因，按当前语言） */
export type HealthProbe = { reachable: true; body?: Record<string, unknown> } | { reachable: false; reason: string };

/** 体检要的现状（插件在 setup 里凑齐；测试换成假的） */
export interface VoiceDoctorFacts {
  /** 组件页的功能门、服务管家里的登记、服务管家的网页、N 卡（内核的 voiceSetup） */
  setup: VoiceSetup;
  speech: {
    /** 合成服务的地址（http://127.0.0.1:8090） */
    url: string;
    /** 预热看到的状态 */
    state(): VoiceModelState;
    /** 上次知道它是什么样子的时刻（毫秒）；还没看过是 undefined */
    checkedAt(): number | undefined;
    /** 多久以内看过算新的（毫秒；两个探活间隔） */
    freshMs: number;
  };
  recognizer: {
    mode(): RecognizeMode;
    state(): VoiceModelState;
    /** 服务管家托管的那条识别服务的地址（voice.recognizer.url）；audio.cpp 那条和合成是同一个地址，自己拉起的没有地址 */
    lsmUrl: string;
  };
  /** 参考音色有几条、语音回复现在用的是哪一条（名字） */
  references(): { count: number; current?: string };
  /** ffmpeg 在哪（找不到是 undefined） */
  ffmpeg(): string | undefined;
  /** 当场探一次 <地址>/health；不给是 probeHealth（测试换成假的，或者给本机假服务的地址） */
  probe?(url: string, signal: AbortSignal): Promise<HealthProbe>;
  /** 此刻（毫秒）；不给是 Date.now（预热记的也是墙上的时间） */
  now?(): number;
  /** 语音插件起来多久了（毫秒，按守护进程的时钟，测试拨得动）：VOICE_STARTUP_GRACE_MS 以内探不通算没查出来；不给是早就起来了 */
  upMs?(): number | undefined;
}

/** 地址是不是这台电脑（平时体检只连本机） */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** 地址的端口（没写按协议的默认）；看不懂是 undefined */
function portOf(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** 给人看的地址：主机和端口（127.0.0.1:8090） */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 当场探一次 <地址>/health（只连本机）：2xx 算连得上，连不上、超时、别的状态码写原因。
 * 限时只数事件循环给了的时间（437，loop-time.ts）：体检、刚启动时事件循环被卡住的那一段不算——不然回应早到了、还没轮到处理，
 * 就先报"1.5 秒没回应"
 */
export async function probeHealth(url: string, signal: AbortSignal, timeoutMs = VOICE_PROBE_TIMEOUT_MS): Promise<HealthProbe> {
  const timer = loopTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.any([signal, timer.signal]) });
    const text = await res.text();
    if (!res.ok) return { reachable: false, reason: t("voice.doctor.probe.status", { status: res.status }) };
    const body = jsonObject(text);
    return { reachable: true, ...(body === undefined ? {} : { body }) };
  } catch (err) {
    if (timer.signal.aborted) return { reachable: false, reason: t("voice.doctor.probe.timeout", { seconds: timeoutMs / 1000 }) };
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED") return { reachable: false, reason: t("voice.doctor.probe.refused") };
    return { reachable: false, reason: t("voice.doctor.probe.failed", { error: messageOf(cause ?? err) }) };
  } finally {
    timer.clear();
  }
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * ffmpeg 在哪：配了命令（测试的假 ffmpeg）就看它的程序；没配找 PATH 上的 ffmpeg（和转码用的同一个，audio-convert.ts）。
 * 找不到是 undefined
 */
export function findFfmpeg(command: readonly string[] | undefined, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const program = command !== undefined && command.length > 0 ? command[0]! : "ffmpeg";
  if (/[\\/]/.test(program)) return fs.existsSync(program) ? program : undefined;
  return findOnPath(program, env);
}

/** 服务管家里的一条写成一句（"语音合成服务（audio.cpp）"（ergo-daemon--audiocpp）） */
function serviceText(service: RegisteredService): string {
  return service.name !== undefined && service.name !== service.id ? t("voice.doctor.service", { name: service.name, id: service.id }) : t("voice.doctor.serviceId", { id: service.id });
}

/** 状态一句话（ready 带模型名） */
function stateText(state: VoiceModelState): string {
  if (state.status === "ready") return state.model ? t("voice.doctor.state.readyModel", { model: state.model }) : t("voice.doctor.state.ready");
  return t(`voice.doctor.state.${state.status}`);
}

/** 识别是哪一种来源 */
function sourceText(mode: RecognizeMode, url: string | undefined): string {
  if (mode === "spawn") return t("voice.doctor.recognizer.source.spawn");
  return t(mode === "lsm" ? "voice.doctor.recognizer.source.lsm" : "voice.doctor.recognizer.source.audiocpp", { url: url === undefined ? "" : hostOf(url) });
}

const notApplicable = (key: string): DoctorFinding => ({ level: "na", fact: { key } });

/** 服务管家里登记在这个地址的端口上的服务（地址不在这台电脑上的不算） */
function registeredAt(setup: VoiceSetup, url: string): RegisteredService | undefined {
  const port = portOf(url);
  return port === undefined || !isLocalUrl(url) ? undefined : setup.registeredOn(port);
}

/**
 * 语音回复开着没有：组件页的"用语音回复"能用，或者服务管家里有一条服务登记在合成服务的端口上（手工登记的 audio.cpp 停着时
 * 组件页认不出它，见文件头）
 */
export function voiceReplyOn(setup: VoiceSetup, speechUrl: string): boolean {
  return setup.featureReady(COMPONENT_FEATURES.voiceReply) || registeredAt(setup, speechUrl) !== undefined;
}

/** 语音输入开着没有：组件页的"按住说话"能用（识别模型装在这儿，或者配了自己的识别） */
export function voiceInputOn(setup: VoiceSetup): boolean {
  return setup.featureReady(COMPONENT_FEATURES.voiceInput);
}

/** 刚起来时探不通（437）：没查出来（不是坏了），写探到的原因，修法是过一会儿再查 */
const startingFinding = (fact: DoctorMessage): DoctorFinding => ({ level: "unknown", fact, fix: { key: "voice.doctor.fixStarting" } });

/** 语音合成、识别这五项（见文件头）；登记进体检由 plugin.ts 做 */
export function voiceDoctorChecks(facts: VoiceDoctorFacts): DoctorCheck[] {
  const { setup } = facts;
  const now = () => (facts.now ?? Date.now)();
  const probe = (url: string, signal: AbortSignal) => (facts.probe ?? probeHealth)(url, signal);
  const replyOn = () => voiceReplyOn(setup, facts.speech.url);
  const inputOn = () => voiceInputOn(setup);
  /** 刚起来（VOICE_STARTUP_GRACE_MS 以内）：探不通这一眼不作数 */
  const starting = (): boolean => {
    const up = facts.upMs?.();
    return up !== undefined && Number.isFinite(up) && up < VOICE_STARTUP_GRACE_MS;
  };

  /** 这台电脑上有服务管家、里面登记在这个地址的端口上的那条（没有的不给按钮，修法照样写） */
  const managed = (url: string | undefined): RegisteredService | undefined => (url === undefined || setup.managerUrl() === undefined ? undefined : registeredAt(setup, url));
  /**
   * 服务停了的修法：到设置 · 服务把登记在这个端口上的那条开起来；按钮"开起来"（418 + 428：和设置 · 服务一页同一个接口，
   * 会过"和二狗有关"、受保护的检查，开完再查一遍）
   */
  const startFix = (url: string): { fix: DoctorMessage; action?: DoctorAction } => {
    const service = registeredAt(setup, url);
    const fix: DoctorMessage = service === undefined ? { key: "voice.doctor.fixStartUnknown", params: { url: hostOf(url) } } : { key: "voice.doctor.fixStart", params: { service: serviceText(service) } };
    const target = managed(url);
    return { fix, ...(target === undefined ? {} : { action: { kind: "start", service: target.id } }) };
  };
  /** 服务在跑却出了错：去看看跳设置 · 服务里它那一块（重启、看日志） */
  const servicesAction = (url: string | undefined): { action?: DoctorAction } => {
    const target = managed(url);
    return target === undefined ? {} : { action: { kind: "open", route: doctorServiceRoute(target.id) } };
  };
  /** 服务登记的那条的名字（修法里"到服务管家重启 X"用）；不知道写地址 */
  const serviceOf = (url: string): string => {
    const service = registeredAt(setup, url);
    return service === undefined ? t("voice.doctor.serviceAt", { url: hostOf(url) }) : serviceText(service);
  };

  const speech: DoctorCheck = {
    id: "speech",
    title: "voice.doctor.speech.title",
    cost: "local",
    timeoutMs: VOICE_PROBE_CHECK_TIMEOUT_MS,
    async run(signal) {
      if (!replyOn()) return notApplicable("voice.doctor.speech.off");
      const { url } = facts.speech;
      const state = facts.speech.state();
      const checkedAt = facts.speech.checkedAt();
      const fresh = checkedAt !== undefined && now() - checkedAt <= facts.speech.freshMs;
      // 预热刚看过（或者地址不在这台电脑上、不去连它）：照它说的；不然当场探一次
      // 连不上时的事实：预热记的原因已经写明了地址（"语音合成服务没开（http://…）"），照它；当场探的写"连不上 <地址>（为什么）"
      const where = hostOf(url);
      // why：刚起来时那一句（预热记的原因已经写明了地址；当场探的写"<地址> 为什么"）
      let down: { fact: DoctorMessage; why: string; since?: string } | undefined;
      if (fresh || !isLocalUrl(url)) {
        if (state.status === "off") {
          const fact: DoctorMessage = state.reason ? { key: "voice.doctor.speech.downState", params: { reason: state.reason } } : { key: "voice.doctor.speech.down", params: { url: where, reason: t("voice.doctor.probe.refused") } };
          down = { fact, why: state.reason || t("voice.doctor.probe.at", { url: where, reason: t("voice.doctor.probe.refused") }), since: state.since };
        }
      } else {
        const result = await probe(url, signal);
        if (!result.reachable) {
          down = { fact: { key: "voice.doctor.speech.down", params: { url: where, reason: result.reason } }, why: t("voice.doctor.probe.at", { url: where, reason: result.reason }), ...(state.status === "off" ? { since: state.since } : {}) };
        }
      }
      // 437：刚起来的这一眼探不通不作数（没查出来），过一会儿再查才照常报坏了
      if (down && starting()) return startingFinding({ key: "voice.doctor.speech.starting", params: { reason: down.why } });
      if (down) return { level: "error", fact: down.fact, ...startFix(url), ...(down.since === undefined ? {} : { since: down.since }) };
      switch (state.status) {
        case "busy":
          return { level: "warn", fact: { key: "voice.doctor.speech.busy", params: { url: where } }, fix: { key: "voice.doctor.speech.fixBusy" }, since: state.since };
        case "error":
          return {
            level: "error",
            fact: { key: "voice.doctor.speech.failed", params: { url: where, reason: state.reason ?? "" } },
            fix: { key: "voice.doctor.speech.fixFailed", params: { service: serviceOf(url) } },
            since: state.since,
            ...servicesAction(url),
          };
        default:
          // 开着：加载好了的带模型名；还没预热、正在加载的照说
          return { level: "ok", fact: { key: "voice.doctor.speech.up", params: { url: where, state: state.status === "off" || state.status === "unloaded" ? t("voice.doctor.state.unknown") : stateText(state) } } };
      }
    },
  };

  const recognizer: DoctorCheck = {
    id: "recognizer",
    title: "voice.doctor.recognizer.title",
    cost: "local",
    timeoutMs: VOICE_PROBE_CHECK_TIMEOUT_MS,
    async run(signal) {
      if (!inputOn()) return notApplicable("voice.doctor.recognizer.off");
      const mode = facts.recognizer.mode();
      const state = facts.recognizer.state();
      const url = mode === "spawn" ? undefined : mode === "lsm" ? facts.recognizer.lsmUrl : facts.speech.url;
      const source = sourceText(mode, url);
      // 用不了的修法：自己拉起的看配置里的 Python；服务那两种看服务管家（audio.cpp 的看组件页）
      const brokenFix = (): { fix: DoctorMessage; action?: DoctorAction } =>
        mode === "spawn"
          ? { fix: { key: "voice.recognizer.hint" }, action: { kind: "open", route: "#/more/voice" } }
          : mode === "lsm"
            ? { fix: { key: "voice.recognizer.lsmHint" }, ...servicesAction(url) }
            : { fix: { key: "voice.recognizer.audiocppHint" }, action: { kind: "open", route: "#/more/components" } };
      const broken = (reason: string, since?: string): DoctorFinding => ({
        level: "error",
        fact: { key: "voice.doctor.recognizer.broken", params: { source, reason } },
        ...brokenFix(),
        ...(since === undefined ? {} : { since }),
      });
      const fine = (status: string): DoctorFinding => ({ level: "ok", fact: { key: "voice.doctor.recognizer.ok", params: { source, state: status } } });

      // 自己拉起的：没有端口，只看状态；服务那两种的状态是刚变的、或者地址不在这台电脑上：也照状态说
      const fresh = now() - Date.parse(state.since) <= RECOGNIZER_FRESH_MS;
      if (url === undefined || fresh || !isLocalUrl(url)) return state.status === "error" ? broken(state.reason ?? "", state.since) : fine(stateText(state));

      // 不新：当场探一次
      const result = await probe(url, signal);
      // 437：刚起来的这一眼探不通不作数（没查出来）
      if (!result.reachable && starting()) return startingFinding({ key: "voice.doctor.recognizer.starting", params: { source, reason: result.reason } });
      if (!result.reachable) {
        return {
          level: "error",
          fact: { key: "voice.doctor.recognizer.down", params: { source, reason: result.reason } },
          ...startFix(url),
          ...(state.status === "error" ? { since: state.since } : {}),
        };
      }
      // 服务管家托管的那条（recognizer.py --serve）自己说模型加载没有、出了什么错
      if (mode === "lsm") {
        const error = result.body?.error;
        if (typeof error === "string" && error !== "") return broken(error);
        if (result.body?.loaded === false) return fine(t("voice.doctor.state.notLoaded"));
      }
      // 连得上，可上次没用成（服务后来又好了也说不定）：下一条语音会再试
      if (state.status === "error") {
        return {
          level: "warn",
          fact: { key: "voice.doctor.recognizer.stale", params: { source, reason: state.reason ?? "" } },
          fix: { key: "voice.doctor.recognizer.fixRetry" },
          since: state.since,
          action: { kind: "open", route: "#/more/voice" },
        };
      }
      return fine(stateText(state));
    },
  };

  const references: DoctorCheck = {
    id: "references",
    title: "voice.doctor.references.title",
    cost: "passive",
    run() {
      if (!replyOn()) return notApplicable("voice.doctor.references.off");
      const { count, current } = facts.references();
      if (count === 0) return { level: "warn", fact: { key: "voice.doctor.references.none" }, fix: { key: "voice.doctor.references.fix" }, action: { kind: "open", route: "#/more/voice" } };
      return { level: "ok", fact: { key: "voice.doctor.references.some", params: { n: count, name: current ?? "" } } };
    },
  };

  const ffmpeg: DoctorCheck = {
    id: "ffmpeg",
    title: "voice.doctor.ffmpeg.title",
    cost: "passive",
    run() {
      if (!replyOn() && !inputOn()) return notApplicable("voice.doctor.voiceOff");
      const found = facts.ffmpeg();
      if (found === undefined) return { level: "warn", fact: { key: "voice.doctor.ffmpeg.missing" }, fix: { key: "voice.doctor.ffmpeg.fix" } };
      return { level: "ok", fact: { key: "voice.doctor.ffmpeg.found", params: { path: found } } };
    },
  };

  // 第一次问 N 卡要跑一次 nvidia-smi（组件那边问过就记住了）：算 local
  const gpu: DoctorCheck = {
    id: "gpu",
    title: "voice.doctor.gpu.title",
    cost: "local",
    run() {
      if (!replyOn() && !inputOn()) return notApplicable("voice.doctor.voiceOff");
      return setup.gpu() === "nvidia" ? { level: "ok", fact: { key: "voice.doctor.gpu.found" } } : notApplicable("voice.doctor.gpu.none");
    },
  };

  return [speech, recognizer, references, ffmpeg, gpu];
}
