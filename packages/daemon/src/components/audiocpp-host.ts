// 语音服务接到服务管家（345 号票，ADR-0038；346 号票，ADR-0039 加了语音识别模型）：audio.cpp 的程序和模型是两个组件，都装好以后这里把它们接起来——
// 生成 server.json（只绑 127.0.0.1、lazy_load 开、模型 id 用配置里的）→ 经 lsm/link.ts 登记 → 启动 → 等 GET /health → 进开机自启名单。
// 哪一步失败都回滚（撤登记、删这次生成的配置）并写清哪一步、什么原因；程序和模型的文件留着，点"启动"不用重新下载。
// 哪些模型算数看清单：写了 serve 的组件都写进 models[]，346 号票再加一条就是再加一个模型，装上、删掉都会重启服务。
// **绝不覆盖用户自己配的服务**：配置（voice.speech.url）指别处、端口已经有人听、服务管家里这个端口已经登记给别人（手写的 audiocpp）、
// 名下已经有同名的登记却不是我们生成的，都算"已有自己配的"：组件显示"在用它"，不下载、不登记。我们生成的认 server.json 在不在。
// 协议碰不到手写在注册表里的服务（名下的服务只看得到自己命名空间），手写的服务停着时只有 put 回的 port-conflict 看得出来：
// 点安装时空跑一次 put，登记得上就马上撤掉；查出来以后每分钟再看一次它撤了没有。
// 组件服务不等这里：装好后的接上、点"启动"都在后台排队（一次一件），页面看 service 的 state；失败不抛错，写进 state 和 error。
// 语音识别模型（serve.task 是 asr）还要多一件（346 号票）：用户自己配了别的语音识别（recognizer-link.ts）就不让装；服务接上了才把识别指过来，删了指回去。
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { formatList, t } from "@ergo/protocol";
import { isPlaceholder } from "../config/config.ts";
import { RequestRejected } from "../errors.ts";
import { DISABLED_LSM_SERVICES, type LsmServiceDefinition, type LsmServices, type LsmServicesReply, type LsmServiceStatus } from "../lsm/link.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import type { ComponentHost, ComponentHostContext } from "./host.ts";
import { type ManifestComponent, type ManifestService, type ManifestVariant, variantFiles } from "./manifest.ts";
import type { RecognizerLink } from "./recognizer-link.ts";
import { findInTree } from "./zip.ts";

export interface AudioCppHostOptions {
  /** 组件区（生成的配置放这里的 audiocpp-service/，不放程序目录：更新程序时那个目录整个换掉） */
  componentsDir: string;
  /** 配置里的 voice.speech */
  speech: { url: string; model: string };
  /** 语音识别那一边（346 号票）：有没有用户自己配的、服务接上了、模型删了；不给就只管服务 */
  recognizer?: RecognizerLink;
  /** 启动以后最多等 GET /health 多久（毫秒）；不给是 30 秒 */
  healthTimeoutMs?: number;
  /** 等健康检查时隔多久看一次（毫秒）；不给是 500 毫秒 */
  healthPollMs?: number;
  /** 探一次端口、健康检查最多等多久（毫秒）；不给是 1.5 秒 */
  probeTimeoutMs?: number;
  /** CPU 版用几个线程；不给按这台电脑的核数 */
  cpuThreads?: number;
  /** 查出来"手写的服务占着这个端口"以后，多久再看一次它撤了没有（毫秒）；不给是一分钟 */
  registeredRecheckMs?: number;
  log: (line: string) => void;
}

export interface AudioCppHost extends ComponentHost {
  /** 接入层建好了：开始用服务管家（守护进程里接入层比组件服务晚建） */
  attachLsm(services: LsmServices): void;
  /** 已有用户自己配的语音合成：给人看的那句话（清单 provided 写的 voice-speech 查它）；没有是 undefined */
  provided(): string | undefined;
}

/** 生成的配置放这里 */
const SERVICE_DIR = "audiocpp-service";
const CONFIG = "server.json";
/** 启动时等就绪的上限（lazy_load 开着，不加载模型，起得快；CUDA 初始化慢一点的机器也够） */
const READY_TIMEOUT_MS = 120_000;
/** 查出来"手写的服务占着这个端口"以后，默认多久再看一次它撤了没有 */
const REGISTERED_RECHECK_MS = 60_000;
/** audio.cpp 读不了带中文的路径（voice/speech.ts 也因此不发请求）；" 和 % 过不了服务管家的 argv（要经 cmd 一层） */
const UNUSABLE_PATH = /[^\x20-\x7e]|["%]/;

type Step = "config" | "register" | "start" | "health" | "autostart";
type ProgramComponent = ManifestComponent & { service: ManifestService };

/**
 * 已有自己配的：地址上有服务、端口有人但不是它、配置指别处；名下有同名的登记却不是我们生成的（owned，每次现看）；
 * 这个端口在服务管家里登记给别人了（registered，空跑 put 才知道，记住结果、隔一阵再看）
 */
type External = { kind: "service" | "port" | "configured"; url: string } | { kind: "owned"; port: number } | { kind: "registered"; port: number; at: number };

/** 一步失败：带上哪一步 */
class StepFailed extends Error {
  readonly step: Step;
  constructor(step: Step, reason: string) {
    super(reason);
    this.step = step;
  }
}

/** 登记时才发现端口已经登记给别人：不算失败，回滚后显示"在用它" */
class AlreadyRegistered extends Error {}

/** 文件名和带 * 的写法对不对得上（不分大小写，Windows 的文件名就是这样） */
function matchesGlob(name: string, pattern: string): boolean {
  const lower = name.toLowerCase();
  const [head = "", ...rest] = pattern.toLowerCase().split("*");
  if (!lower.startsWith(head)) return false;
  if (rest.length === 0) return lower === head;
  let at = head.length;
  for (const part of rest.slice(0, -1)) {
    const found = lower.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  const tail = rest.at(-1) ?? "";
  return lower.length - tail.length >= at && lower.endsWith(tail);
}
const concerns = (c: ManifestComponent): boolean => c.service !== undefined || c.serve !== undefined;
/** 语音识别模型（346 号票） */
const isRecognizerModel = (c: ManifestComponent): boolean => c.serve?.task === "asr";
const healthUrl = (service: ManifestService) => `http://127.0.0.1:${service.port}${service.health}`;
const replyError = (reply: LsmServicesReply): string => (reply.ok ? "" : reply.error.message);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 这一版的程序旁边应该有、却没有的文件（CUDA 运行库）。只提示、不挡启动：名字是从上游的打包脚本读来的，没有拿真包核对过，
 * 对不上时不能把本来能跑的挡住；真起不来时这句话就在错误后面
 */
function runtimeWarning(program: ProgramComponent, installed: { dir: string; variant: ManifestVariant }): string | undefined {
  const expected = installed.variant.expects ?? [];
  if (expected.length === 0) return undefined;
  const programPath = findInTree(installed.dir, program.service.program);
  if (!programPath) return undefined;
  const dir = path.dirname(programPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const missing = expected.filter((pattern) => !names.some((name) => matchesGlob(name, pattern)));
  if (missing.length === 0) return undefined;
  const runtimePackage = variantFiles(installed.variant).find(({ file }) => file.extract?.beside !== undefined)?.file.path ?? "";
  return t("components.service.runtimeMissing", { dir, files: formatList(missing), package: runtimePackage });
}

export function createAudioCppHost(options: AudioCppHostOptions): AudioCppHost {
  const { log } = options;
  const healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
  const healthPollMs = options.healthPollMs ?? 500;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1500;
  const serviceDir = path.join(options.componentsDir, SERVICE_DIR);
  const configPath = path.join(serviceDir, CONFIG);

  let context: ComponentHostContext | undefined;
  let lsm: LsmServices = DISABLED_LSM_SERVICES;
  let unsubscribe: (() => void)[] = [];
  /** 服务管家推来的这个服务的状态：没有是没登记（或者还没接上） */
  let status: LsmServiceStatus | undefined;
  let external: External | undefined;
  /** 我们的服务 GET /health 通不通（服务管家还没接上时看它） */
  let healthy = false;
  /** 排着和正在做的"接上"有几个：有就显示"启动中" */
  let connecting = 0;
  let lastError: string | undefined;
  let stopped = false;
  /** 正在空跑登记：这期间推来的状态是我们自己弄出来的，不算数 */
  let dryRunning = false;
  /** 一次一件：接上、停、撤登记不并发 */
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  };
  const changed = () => context?.changed();

  /** 清单里的程序组件（带 service 的） */
  const programComponent = (): ProgramComponent | undefined => context?.manifest.components.find((c): c is ProgramComponent => c.service !== undefined);
  /** 装好了的、由这个程序加载的模型（except 是正要删的那个） */
  const installedModels = (except?: string): { component: ManifestComponent; dir: string }[] =>
    (context?.manifest.components ?? []).flatMap((c) => {
      if (!c.serve || c.id === except) return [];
      const installed = context?.installed(c.id);
      return installed ? [{ component: c, dir: installed.dir }] : [];
    });
  /** 这个服务是我们接上的：有我们生成的 server.json 就是（回滚、撤销时删掉） */
  const ours = (): boolean => fs.existsSync(configPath);

  const modelId = (c: ManifestComponent): string => {
    const serve = c.serve!;
    // 语音回复按配置里的模型 id 要，服务上就得叫这个；还是占位符（抄了示例没填）的用清单里的
    return serve.task === "tts" && !isPlaceholder(options.speech.model) ? options.speech.model : serve.id;
  };

  /** 生成的配置：models[] 是清单里写了 serve、装好了的全部；路径原样写，audio.cpp 按写的读 */
  const configText = (program: ProgramComponent, variant: ManifestVariant): string => {
    const cuda = variant.id === "cuda";
    const config = {
      host: "127.0.0.1",
      port: program.service.port,
      backend: cuda ? "cuda" : "cpu",
      device: 0,
      threads: cuda ? 1 : (options.cpuThreads ?? Math.max(1, os.availableParallelism())),
      lazy_load: true,
      models: installedModels().map(({ component, dir }) => ({
        id: modelId(component),
        family: component.serve!.family,
        path: path.join(dir, ...component.serve!.file.split("/")),
        task: component.serve!.task,
        mode: component.serve!.mode,
      })),
    };
    return `${JSON.stringify(config, null, 2)}\n`;
  };

  const definition = (service: ManifestService, programPath: string): LsmServiceDefinition => ({
    name: service.name,
    title: t("components.service.title"),
    argv: [programPath, "--config", CONFIG],
    cwd: serviceDir,
    port: service.port,
    health: { path: service.health, timeoutMs: 3000 },
    readyTimeoutMs: READY_TIMEOUT_MS,
  });

  /** GET /health 回 2xx */
  const healthOk = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(probeTimeoutMs) });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  };

  /** 这个端口有人听吗（连上了不回话、半天连不上都当有人：宁可不覆盖） */
  const portOpen = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const done = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(probeTimeoutMs, () => done(true));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });

  /** 配置里的地址就是我们要接管的这个端口（默认的 127.0.0.1:8090） */
  const pointsAtManaged = (service: ManifestService): boolean => {
    try {
      const url = new URL(options.speech.url);
      return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && Number(url.port) === service.port;
    } catch {
      return false;
    }
  };

  /** 现看一眼有没有用户自己配的（不含手写登记：那个要空跑 put，只在点安装时跑） */
  const detectExternal = async (service: ManifestService): Promise<External | undefined> => {
    if (!pointsAtManaged(service)) return { kind: "configured", url: options.speech.url };
    if (status) return { kind: "owned", port: service.port };
    if (!(await portOpen(service.port))) return undefined;
    return { kind: (await healthOk(`${options.speech.url}${service.health}`)) ? "service" : "port", url: options.speech.url };
  };

  /** 空跑一次登记：这个端口在服务管家里已经登记给别人了吗；登记得上就马上撤掉 */
  const dryRunRegister = async (service: ManifestService): Promise<External | undefined> => {
    if (lsm.support !== "supported") return undefined;
    fs.mkdirSync(serviceDir, { recursive: true });
    dryRunning = true;
    try {
      const put = await lsm.put(definition(service, path.join(serviceDir, service.program)));
      if (put.ok) {
        const removed = await lsm.remove(service.name);
        if (!removed.ok) log(`安装前试登记完没撤掉 ${service.name}：${replyError(removed)}`);
        return undefined;
      }
      if (put.error.code === "port-conflict") return { kind: "registered", port: service.port, at: Date.now() };
      log(`安装前试登记 ${service.name} 没成（${put.error.code}）：${put.error.message}`);
      return undefined;
    } finally {
      dryRunning = false;
      status = undefined;
    }
  };

  const externalText = (found: External): string => {
    switch (found.kind) {
      case "service":
        return t("components.provided.speechService", { url: found.url });
      case "port":
        return t("components.provided.speechPort", { url: found.url });
      case "configured":
        return t("components.provided.speechConfigured", { url: found.url });
      case "owned":
      case "registered":
        return t("components.provided.speechRegistered", { port: found.port });
    }
  };

  const look = async (): Promise<void> => {
    const program = programComponent();
    if (!program || stopped || dryRunning) return;
    if (ours()) {
      external = undefined;
      healthy = await healthOk(healthUrl(program.service));
      return;
    }
    healthy = false;
    // 手写的登记查出来过：过一阵再空跑一次，撤了就不再算
    if (external?.kind === "registered" && !status) {
      if (Date.now() - external.at < (options.registeredRecheckMs ?? REGISTERED_RECHECK_MS)) return;
      external = await enqueue(() => dryRunRegister(program.service));
      if (external) return;
    }
    external = await detectExternal(program.service);
  };

  /** 现看一眼；看不了（目录建不了……）只记日志，不挡取清单 */
  const refresh = (): Promise<void> => look().catch((err: unknown) => log(`语音合成：看现状时出错：${errorText(err)}`));

  /** 回滚：撤掉这次的登记（原来就登记着的不撤）、配置回到原来的样子；回滚本身没做成的写进返回的说明 */
  const rollback = async (service: ManifestService, before: { registered: boolean; running: boolean; config: string | undefined }): Promise<string[]> => {
    const notes: string[] = [];
    if (!before.registered) {
      await lsm.autostart(service.name, false);
      const removed = await lsm.remove(service.name);
      if (!removed.ok && removed.error.code !== "not-found") notes.push(t("components.service.rollbackFailed", { reason: removed.error.message }));
    } else if (!before.running) {
      await lsm.stop(service.name, { force: true });
    }
    try {
      if (before.config === undefined) fs.rmSync(configPath, { force: true });
      else writeFileAtomic(configPath, before.config);
    } catch (err) {
      notes.push(t("components.service.rollbackFailed", { reason: errorText(err) }));
    }
    // 加模型、更新失败：原来在跑的尽量让它接着用原来的配置跑
    if (before.registered && before.running && before.config !== undefined) {
      const back = await lsm.restart(service.name, { force: true });
      if (!back.ok) log(`回滚后 ${service.name} 没重新起来：${back.error.message}`);
    }
    return notes;
  };

  /** 等 GET /health 回 2xx */
  const waitHealthy = async (service: ManifestService): Promise<void> => {
    const url = healthUrl(service);
    const deadline = Date.now() + healthTimeoutMs;
    for (;;) {
      if (await healthOk(url)) return;
      if (stopped) throw new StepFailed("health", t("components.service.stopping"));
      if (Date.now() >= deadline) throw new StepFailed("health", t("components.service.healthTimeout", { url, seconds: Math.round(healthTimeoutMs / 1000) }));
      await new Promise((resolve) => setTimeout(resolve, healthPollMs));
    }
  };

  /** 生成配置 → 登记 → 启动（模型变了、在跑的重启）→ 健康检查 → 进名单；失败回滚、写进 lastError */
  const connect = async (restart: boolean): Promise<void> => {
    const program = programComponent();
    const installed = program && context?.installed(program.id);
    if (!program || !installed || stopped || installedModels().length === 0) return;
    const { service } = program;
    const firstTime = !ours();
    if (firstTime) {
      const found = await detectExternal(service);
      if (found) {
        external = found;
        log(`语音合成：已有用户自己配的（${found.kind}），不覆盖`);
        return;
      }
    }
    lastError = undefined;
    changed();
    const before = { registered: status !== undefined, running: status?.up === true, config: firstTime ? undefined : fs.readFileSync(configPath, "utf8") };
    try {
      // 发布包解开后程序在哪一层由包决定，不写死，按文件名找
      const programPath = findInTree(installed.dir, service.program);
      if (!programPath) throw new StepFailed("config", t("components.service.noProgram", { program: service.program, dir: installed.dir }));
      try {
        fs.mkdirSync(serviceDir, { recursive: true });
        writeFileAtomic(configPath, configText(program, installed.variant));
      } catch (err) {
        throw new StepFailed("config", errorText(err));
      }
      const put = await lsm.put(definition(service, programPath));
      if (!put.ok && put.error.code === "port-conflict") throw new AlreadyRegistered(put.error.message);
      if (!put.ok) throw new StepFailed("register", put.error.message);
      const started = restart && before.running ? await lsm.restart(service.name, { force: true }) : await lsm.start(service.name);
      if (!started.ok) throw new StepFailed("start", started.error.message);
      await waitHealthy(service);
      const autostart = await lsm.autostart(service.name, true);
      if (!autostart.ok) throw new StepFailed("autostart", autostart.error.message);
      healthy = true;
      log(`语音服务接上了：端口 ${service.port}，${installedModels().length} 个模型，进了开机自启名单`);
      if (installedModels().some(({ component }) => isRecognizerModel(component))) options.recognizer?.connected();
    } catch (err) {
      // 守护进程正在停：接入层已经断了，回滚也撤不掉登记。配置和登记都留着，下次起来还认得是我们的，点启动就行
      if (stopped) {
        log(`语音服务接到一半守护进程停了（${errorText(err)}）`);
        return;
      }
      const notes = await rollback(service, before);
      healthy = false;
      if (err instanceof AlreadyRegistered) {
        external = { kind: "registered", port: service.port, at: Date.now() };
        log(`语音合成：端口已经登记给别的服务了（${err.message}），不覆盖`);
        return;
      }
      const step: Step = err instanceof StepFailed ? err.step : "config";
      const runtime = runtimeWarning(program, installed);
      lastError = [t("components.service.failed", { step: t(`components.service.step.${step}`), reason: errorText(err) }), ...(runtime ? [runtime] : []), ...notes].join(" ");
      log(`语音服务没接上（${step}）：${errorText(err)}；已回滚`);
    }
  };

  /** 排一次"接上"；马上显示"启动中"（程序和模型都装好了才有事做） */
  const schedule = (restart: boolean): void => {
    const program = programComponent();
    if (!program || stopped || !context?.installed(program.id) || installedModels().length === 0) return;
    connecting += 1;
    changed();
    void enqueue(() => connect(restart))
      .catch((err: unknown) => log(`语音服务接上时出错：${errorText(err)}`))
      .finally(() => {
        connecting -= 1;
        changed();
      });
  };

  /** 撤登记和名单、删生成的配置 */
  const unregister = async (service: ManifestService): Promise<void> => {
    if (!ours()) return;
    const off = await lsm.autostart(service.name, false);
    if (!off.ok && off.error.code !== "not-found") throw new RequestRejected("not_allowed", t("components.reject.serviceRemove", { reason: off.error.message }));
    const removed = await lsm.remove(service.name);
    if (!removed.ok && removed.error.code !== "not-found") throw new RequestRejected("not_allowed", t("components.reject.serviceRemove", { reason: removed.error.message }));
    fs.rmSync(configPath, { force: true });
    status = undefined;
    healthy = false;
    lastError = undefined;
    log(`撤掉了语音服务的登记和开机自启（${service.name}）`);
  };

  /** 服务停下来（文件要换、要删）：没登记的不算错 */
  const halt = async (service: ManifestService): Promise<LsmServicesReply | undefined> => {
    if (!ours()) return undefined;
    const reply = await lsm.stop(service.name, { force: true });
    healthy = false;
    return reply.ok || reply.error.code === "not-found" ? undefined : reply;
  };

  return {
    attach(next) {
      context = next;
    },
    attachLsm(services) {
      for (const off of unsubscribe) off();
      lsm = services;
      unsubscribe = [
        services.onStatus((message) => {
          const name = programComponent()?.service.name;
          if (name === undefined || dryRunning) return;
          if (message.full) status = undefined;
          for (const one of message.services) if (one.name === name) status = one;
          if (message.removed.includes(name)) status = undefined;
          changed();
        }),
        services.onSupport(() => changed()),
      ];
    },
    provided() {
      return external && !ours() ? externalText(external) : undefined;
    },
    blocked(component) {
      if (!concerns(component)) return undefined;
      if (UNUSABLE_PATH.test(options.componentsDir)) return t("components.cannot.pathUnusable", { dir: options.componentsDir });
      const recognizer = isRecognizerModel(component);
      // 用户自己配了别的语音识别：不改（已经从这里装好了的要能更新，不算）
      if (recognizer && !context?.installed(component.id) && options.recognizer?.configured() !== undefined) return t("components.cannot.recognizerConfigured");
      if (!external || ours()) return undefined;
      return t(recognizer ? "components.cannot.recognizerExternal" : "components.cannot.speechExternal");
    },
    async preflight(component) {
      const program = programComponent();
      if (!program || !concerns(component) || ours()) return;
      await refresh();
      // 端口空着、也没人说它是谁的：手写的服务可能只是停着，问服务管家才知道
      external ??= await enqueue(() => dryRunRegister(program.service));
      if (external) {
        changed();
        throw new RequestRejected("not_allowed", externalText(external));
      }
      // 没接上服务管家：下完 6 GB 也接不上，现在就说（重连中的不算，到时候失败了能重试）
      if (lsm.support === "disabled" || lsm.support === "unsupported") {
        throw new RequestRejected("not_allowed", t("components.reject.noSupervisor", { reason: replyError(await lsm.list()) }));
      }
    },
    async beforeReplace(component) {
      const program = programComponent();
      if (!program || !concerns(component)) return;
      const failed = await enqueue(() => halt(program.service));
      if (failed) throw new Error(replyError(failed));
    },
    installed(component) {
      if (concerns(component)) schedule(true);
    },
    async beforeRemove(component) {
      const program = programComponent();
      if (!program || !concerns(component)) return;
      await enqueue(async () => {
        if (component.service !== undefined || installedModels(component.id).length === 0) return unregister(program.service);
        // 还有别的模型：先停（模型文件被占着删不掉），删完重启
        const failed = await halt(program.service);
        if (failed) throw new RequestRejected("not_allowed", t("components.reject.serviceRemove", { reason: replyError(failed) }));
        return undefined;
      });
    },
    removed(component) {
      if (isRecognizerModel(component)) options.recognizer?.removed();
      if (component.serve) schedule(true);
    },
    async control(component, action) {
      const program = programComponent();
      if (!program || component.service === undefined || !context?.installed(program.id)) throw new RequestRejected("not_allowed", t("components.reject.noService"));
      if (action === "start") {
        if (installedModels().length === 0) throw new RequestRejected("not_allowed", t("components.service.noModel"));
        if (connecting === 0) schedule(false);
        return;
      }
      await enqueue(async () => {
        const reply = await lsm.stop(program.service.name, { force: true });
        if (!reply.ok) throw new RequestRejected("not_allowed", t("components.reject.serviceStop", { reason: reply.error.message }));
        healthy = false;
      });
    },
    service(component) {
      const program = programComponent();
      if (!program || component.id !== program.id || !context?.installed(program.id)) return undefined;
      const installed = context.installed(program.id);
      const warning = installed && lastError === undefined ? runtimeWarning(program, installed) : undefined;
      const base = { port: program.service.port, autostart: status?.autostart === true, ...(warning ? { warning } : {}) };
      if (connecting > 0) return { ...base, state: "starting" };
      if (lastError !== undefined) return { ...base, state: "failed", error: lastError };
      if (external && !ours()) return { ...base, state: "idle", note: externalText(external) };
      if (installedModels().length === 0) return { ...base, state: "idle", note: t("components.service.noModel") };
      if (!status) return { ...base, state: ours() && healthy ? "running" : "stopped" };
      if (status.up) return { ...base, state: "running" };
      if (status.state === "STARTING") return { ...base, state: "starting" };
      if (status.state === "FAILED") return { ...base, state: "failed", ...(status.lastError ? { error: status.lastError } : {}) };
      return { ...base, state: "stopped" };
    },
    refresh,
    whenIdle: () => chain.then(() => undefined),
    stop() {
      stopped = true;
      for (const off of unsubscribe) off();
      unsubscribe = [];
    },
  };
}
