// 体检项的登记表和跑法（409）。
// - 插件在 setup 里 ctx.doctor.register(check)：插件宿主转到这里、记上插件名，返回撤销函数，停用、移除时跟着撤（和给 agent 登记工具
//   同一套，plugins/host.ts）——插件停用了，体检页上它那一块就没了，再启用是新的一次 setup、检查项跟着回来。
//   内核自己的检查（410 起）由组合根不带插件名登记，放在"二狗本身"那一块。
// - 每项声明 cost：passive（只读内存、文件、事件）或 local（连本机端口、起本机进程）。平时体检两种都跑：不联网、不调模型、
//   不改东西，但可以连这台电脑上二狗在用的服务的端口（用户 11-07 同意的放宽）。
//   第三档 deep（415 深度体检）：真试一遍——真发一句话测模型、连外网、跑本机命令看登录、整库完整性检查。平时体检不跑它，
//   只有用户在体检页上点了"深度体检"才跑（deep.ts），秘书也不跑；超时照样只算这一项"没查出来"。
// - 跑：每项有超时（默认 DOCTOR_CHECK_TIMEOUT_MS），到点了置中止信号；超时、抛错、交回的东西不像样都只算这一项"没查出来"（unknown），
//   不影响别的项。同步的死循环拦不住——run 要快，重活先在后台算好、这里只读结果（Jenkins 的 isActivated 也这么要求）。
// - 结果（DoctorFinding）是结构化的：五种结果之一、事实和怎么修（文案键 + 参数，键放插件自己的语言文件 <插件>.doctor.*）、
//   可选的"从什么时候起"和一个动作按钮。守护进程不在这里拼界面的字，拼在 doctor.ts。
// @i18n-ignore-file log：登记出错的说明是给开发者看的（编程错误）
import { DOCTOR_FIX_UNKNOWN, DOCTOR_LEVELS, type DoctorAction, type DoctorLevel, type DoctorMessage, doctorOpensUrl } from "@ergo/protocol";
import { oneLine } from "../util/text.ts";

/** 一项检查的开销：passive 只读内存、文件、事件；local 连本机端口、起本机进程；deep 深度体检才跑（真调模型、连外网、慢活，415） */
export const DOCTOR_COSTS = ["passive", "local", "deep"] as const;
export type DoctorCost = (typeof DOCTOR_COSTS)[number];

/** 一项检查默认最多等多久（毫秒）：超了算"没查出来" */
export const DOCTOR_CHECK_TIMEOUT_MS = 1_500;

/** 出错原文最多带多少字进"没查出来"那句 */
const ERROR_TEXT_MAX = 160;

/** 一项查出来的样子 */
export interface DoctorFinding {
  level: DoctorLevel;
  /** 查出来的事实：文案键 + 参数（时间、数字先按当前语言写好） */
  fact: DoctorMessage;
  /** 怎么修（健康时一般不给） */
  fix?: DoctorMessage;
  /** 从什么时候起是这个样子（ISO） */
  since?: string;
  /** 一个动作按钮（open 跳到某一页，compact 现在压缩某个 agent 的对话） */
  action?: DoctorAction;
}

/** 一项检查（插件经 ctx.doctor.register 登记、内核经组合根登记） */
export interface DoctorCheck {
  /** 块里唯一：小写英文、数字和连字符（"index"、"nightly"）；"plugin" 和原来八项的 id 留给二狗自己 */
  id: string;
  /** 这一项的名字：文案键（"memory.doctor.index.title"），要带参数时写成 DoctorMessage */
  title: string | DoctorMessage;
  cost: DoctorCost;
  /** 最多等多久（毫秒）；不给是 DOCTOR_CHECK_TIMEOUT_MS */
  timeoutMs?: number;
  /** 查一次：signal 在超时、体检不要了时置位。抛错、超时都算"没查出来" */
  run(signal: AbortSignal): DoctorFinding | Promise<DoctorFinding>;
}

/** 登记表里的一项：插件登记的带插件名，内核的没有（放"二狗本身"） */
export interface RegisteredDoctorCheck extends DoctorCheck {
  readonly plugin?: string;
}

export interface DoctorCheckRegistry {
  /** 登记一项；id 不合规矩、同一块里重名抛错。返回撤销函数 */
  register(check: RegisteredDoctorCheck): () => void;
  /** 现在登记着的（按登记的先后） */
  list(): readonly RegisteredDoctorCheck[];
}

/** 检查项 id 的规矩 */
const CHECK_ID = /^[a-z][a-z0-9-]*$/;

/** 二狗自己用的 id：插件块里二狗替插件生成的那一行、"二狗本身"里原来的八项 */
const RESERVED_IDS = new Set(["plugin", "ports", "node", "pi", "supervisor", "model", "components", "disk", "external"]);

export function createDoctorChecks(): DoctorCheckRegistry {
  const checks: RegisteredDoctorCheck[] = [];
  return {
    register(check) {
      const where = check.plugin === undefined ? "二狗本身" : `插件 ${check.plugin}`;
      if (!CHECK_ID.test(check.id)) throw new Error(`体检项的 id 不合规矩（小写英文、数字和连字符）：${where} 的 ${check.id}`);
      if (RESERVED_IDS.has(check.id)) throw new Error(`体检项的 id ${check.id} 是二狗自己用的：${where} 换一个`);
      if (!(DOCTOR_COSTS as readonly string[]).includes(check.cost)) throw new Error(`体检项 ${where} 的 ${check.id} 的 cost 不认得：${String(check.cost)}`);
      if (checks.some((c) => c.plugin === check.plugin && c.id === check.id)) throw new Error(`体检项重名：${where} 已经有 ${check.id}`);
      const entry = { ...check };
      checks.push(entry);
      return () => {
        const at = checks.indexOf(entry);
        if (at >= 0) checks.splice(at, 1);
      };
    },
    list: () => [...checks],
  };
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 这一项这次没查出来：事实写为什么（超时、出错、交回的东西看不懂），修法是"再查一遍" */
function unknownFinding(fact: DoctorMessage): DoctorFinding {
  return { level: "unknown", fact, fix: { key: DOCTOR_FIX_UNKNOWN } };
}

const isMessage = (value: unknown): value is DoctorMessage =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DoctorMessage).key === "string" &&
  (value as DoctorMessage).key !== "" &&
  ((value as DoctorMessage).params === undefined || (typeof (value as DoctorMessage).params === "object" && (value as DoctorMessage).params !== null));

const isAction = (value: unknown): value is DoctorAction => {
  if (typeof value !== "object" || value === null) return false;
  const action = value as Partial<{ kind: string; route: unknown; agentId: unknown }>;
  // open：二狗的某一页（#/…），或者本机的一个网址（服务管家的网页：410 托管的服务、413 语音）；外面的网站不认
  if (action.kind === "open") return typeof action.route === "string" && (action.route.startsWith("#/") || doctorOpensUrl(action.route));
  if (action.kind === "compact") return typeof action.agentId === "string" && action.agentId !== "";
  return false;
};

/** 交回的东西像不像样：结果是五种之一、事实是一句话，可选的几样形状对；不像样的交回 undefined */
export function validFinding(value: unknown): DoctorFinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const f = value as Partial<DoctorFinding>;
  if (!(DOCTOR_LEVELS as readonly unknown[]).includes(f.level) || !isMessage(f.fact)) return undefined;
  if (f.fix !== undefined && !isMessage(f.fix)) return undefined;
  if (f.since !== undefined && (typeof f.since !== "string" || Number.isNaN(Date.parse(f.since)))) return undefined;
  if (f.action !== undefined && !isAction(f.action)) return undefined;
  return {
    level: f.level as DoctorLevel,
    fact: f.fact,
    ...(f.fix === undefined ? {} : { fix: f.fix }),
    ...(f.since === undefined ? {} : { since: f.since }),
    ...(f.action === undefined ? {} : { action: f.action }),
  };
}

/**
 * 查一项：到点了（check.timeoutMs，默认 DOCTOR_CHECK_TIMEOUT_MS）置中止信号、算"没查出来"；抛错、交回的东西不像样也是"没查出来"。
 * 从不抛错。log 记下没查出来的原因（给开发者看）
 */
export async function runDoctorCheck(check: DoctorCheck, log?: (line: string) => void): Promise<DoctorFinding> {
  const timeoutMs = check.timeoutMs ?? DOCTOR_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    // 同步抛的错也接住：放进 then 里跑
    const outcome = await Promise.race([Promise.resolve().then(() => check.run(controller.signal)), timedOut]);
    if (outcome === "timeout") {
      controller.abort();
      log?.(`体检项 ${check.id} ${timeoutMs} 毫秒没查完，算没查出来`);
      return unknownFinding({ key: "doctor.unknown.timeout", params: { seconds: Math.round((timeoutMs / 1000) * 10) / 10 } });
    }
    const finding = validFinding(outcome);
    if (finding) return finding;
    log?.(`体检项 ${check.id} 交回的结果不像样，算没查出来：${oneLine(JSON.stringify(outcome) ?? String(outcome), ERROR_TEXT_MAX)}`);
    return unknownFinding({ key: "doctor.unknown.bad" });
  } catch (err) {
    log?.(`体检项 ${check.id} 查的时候出错，算没查出来：${describe(err)}`);
    return unknownFinding({ key: "doctor.unknown.failed", params: { message: oneLine(describe(err), ERROR_TEXT_MAX) } });
  } finally {
    clearTimeout(timer);
  }
}
