// 深度体检（415）：体检页上点了"深度体检"才跑，真试一遍——用默认模型真发一句很短的话、拿存着的 Key 连一下数据源、
// 看 Claude Code / Codex 登录了没有、对 ergo.db 跑只读的完整性检查（要跑哪些由 doctor.ts 的 deepPlan() 列：登记表里 cost 是 deep 的，
// 加上登记了 probe 的数据源）。外面先例的写法（.scratch/ergo-v2/research/2026-11-07-doctor-prior-art.md 第 3.4、6、7 条）：
// - 点了才跑，逐项跑、逐项出结果：同时最多跑 DEEP_DOCTOR_CONCURRENCY 项（OpenClaw 测模型的并发也是 2），每项测完马上记下，
//   网页正在测时每秒取一次（GET /api/doctor/deep），看到的是测完的几项 + 还在测的几项；
// - 结果留在内存里（守护进程重启就没了，不落盘）：打开体检页只取上一次的（"3 分钟前测的"），再点才重测；
// - 防连点：上一次测完不到 DEEP_DOCTOR_MIN_GAP_MS 不让再测（start 抛 DeepDoctorTooSoon，接口回 429）；正在测时再点交回正在测的那一份；
// - 每项的超时、抛错由 runDoctorCheck 接住，只算这一项"没查出来"；一项卡住不耽误别的项（各自的时限）；
// - 秘书不跑：它的只读体检工具（tool.ts）只读这里最近一次的结果。
// 句子：测完的存草稿（文案键 + 参数），取的时候按当前语言拼（换了语言再取就是新语言）；块的标题也是取的时候现取。
// @i18n-ignore-file log：日志、出错说明给开发者看；给人看的走 t()
import { DOCTOR_FIX_UNKNOWN, type DoctorDeepItemView, type DoctorDeepView, doctorItemText, type DoctorMessage, t } from "@ergo/protocol";
import type { DoctorFinding } from "./checks.ts";
import type { DoctorDeepCheck, DoctorService } from "./doctor.ts";

/** 两次深度体检之间至少隔多久（毫秒，从上一次测完算）：防连点 */
export const DEEP_DOCTOR_MIN_GAP_MS = 60_000;
/** 同时最多跑几项 */
export const DEEP_DOCTOR_CONCURRENCY = 2;

/** 离上一次测完太近，不让再测：retryAfterMs 是还要等多久 */
export class DeepDoctorTooSoon extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(t("doctor.deep.tooSoon", { seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }));
    this.name = "DeepDoctorTooSoon";
    this.retryAfterMs = retryAfterMs;
  }
}

/** 一项：在测的没有 finding；测完的有结果和测了多久 */
interface Slot {
  readonly group: string;
  readonly id: string;
  readonly title: DoctorMessage;
  finding?: DoctorFinding;
  ms?: number;
}

/** 一次深度体检 */
interface DeepRun {
  readonly startedAt: number;
  finishedAt?: number;
  readonly slots: Slot[];
  readonly done: Promise<void>;
}

export interface DeepDoctorService {
  /** 上一次（或正在测的这一次）的样子：只取，不跑 */
  view(): DoctorDeepView;
  /** 开测：正在测时交回正在测的那一份；离上一次测完不到 DEEP_DOCTOR_MIN_GAP_MS 抛 DeepDoctorTooSoon */
  start(): DoctorDeepView;
  /** 正在测的这一次测完（测试、停守护进程时等） */
  whenIdle(): Promise<void>;
}

export interface DeepDoctorOptions {
  doctor: Pick<DoctorService, "deepPlan" | "groupTitle">;
  /** 此刻（毫秒时间戳）；不给是 Date.now。测试换成可拨的 */
  now?: () => number;
  /** 两次之间至少隔多久；不给是 DEEP_DOCTOR_MIN_GAP_MS */
  minGapMs?: number;
  /** 同时最多跑几项；不给是 DEEP_DOCTOR_CONCURRENCY */
  concurrency?: number;
  log?: (line: string) => void;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createDeepDoctor(options: DeepDoctorOptions): DeepDoctorService {
  const now = options.now ?? Date.now;
  const minGapMs = options.minGapMs ?? DEEP_DOCTOR_MIN_GAP_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEEP_DOCTOR_CONCURRENCY);
  const log = options.log ?? (() => {});
  let current: DeepRun | undefined;

  /** 一项写成网页要的样子：句子、块的标题按当前语言现拼 */
  const itemView = (slot: Slot): DoctorDeepItemView => {
    const title = t(slot.title.key, slot.title.params);
    const base = { group: slot.group, groupTitle: options.doctor.groupTitle(slot.group), id: slot.id, title };
    if (slot.finding === undefined) return { ...base, state: "pending" };
    const { finding } = slot;
    const shape = { title: slot.title, fact: finding.fact, ...(finding.fix === undefined ? {} : { fix: finding.fix }) };
    return {
      ...base,
      state: "done",
      item: {
        id: slot.id,
        level: finding.level,
        ...shape,
        ...(finding.since === undefined ? {} : { since: finding.since }),
        ...(finding.action === undefined ? {} : { action: finding.action }),
        text: doctorItemText(shape),
      },
      ...(slot.ms === undefined ? {} : { ms: slot.ms }),
    };
  };

  const view = (): DoctorDeepView => {
    const at = now();
    if (!current) return { state: "never", items: [], counts: { error: 0, warn: 0, unknown: 0 }, now: iso(at) };
    const run = current;
    const counts = { error: 0, warn: 0, unknown: 0 };
    for (const slot of run.slots) {
      const level = slot.finding?.level;
      if (level === "error" || level === "warn" || level === "unknown") counts[level] += 1;
    }
    const next = run.finishedAt === undefined ? undefined : run.finishedAt + minGapMs;
    return {
      state: run.finishedAt === undefined ? "running" : "done",
      startedAt: iso(run.startedAt),
      ...(run.finishedAt === undefined ? {} : { finishedAt: iso(run.finishedAt) }),
      ...(next !== undefined && next > at ? { nextAt: iso(next) } : {}),
      items: run.slots.map(itemView),
      counts,
      now: iso(at),
    };
  };

  /** 按先后跑，同时最多 concurrency 项；每项测完马上记下（runDoctorCheck 从不抛错，这里再兜一层） */
  const execute = async (plan: readonly DoctorDeepCheck[], slots: Slot[]): Promise<void> => {
    let next = 0;
    const worker = async () => {
      while (next < plan.length) {
        const at = next++;
        const check = plan[at]!;
        const slot = slots[at]!;
        const started = now();
        try {
          slot.finding = await check.run();
        } catch (err) {
          log(`深度体检 ${check.group}:${check.id} 出错（算没查出来）：${err instanceof Error ? err.message : String(err)}`);
          slot.finding = { level: "unknown", fact: { key: "doctor.unknown.failed", params: { message: err instanceof Error ? err.message : String(err) } }, fix: { key: DOCTOR_FIX_UNKNOWN } };
        }
        slot.ms = Math.max(0, now() - started);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
  };

  const start = (): DoctorDeepView => {
    if (current && current.finishedAt === undefined) return view();
    const at = now();
    if (current?.finishedAt !== undefined && at - current.finishedAt < minGapMs) throw new DeepDoctorTooSoon(current.finishedAt + minGapMs - at);
    const plan = options.doctor.deepPlan();
    const slots: Slot[] = plan.map((check) => ({ group: check.group, id: check.id, title: check.title }));
    log(`深度体检开始：${plan.length} 项（${plan.map((check) => `${check.group}:${check.id}`).join("、") || "没有"}）`);
    const run: DeepRun = {
      startedAt: at,
      slots,
      done: execute(plan, slots).finally(() => {
        run.finishedAt = Math.max(now(), run.startedAt);
        const bad = slots.filter((slot) => slot.finding?.level === "error" || slot.finding?.level === "warn").map((slot) => `${slot.group}:${slot.id}=${slot.finding!.level}`);
        log(`深度体检测完了：${bad.length === 0 ? "没有坏的、要注意的" : bad.join("、")}`);
      }),
    };
    current = run;
    return view();
  };

  return {
    view,
    start,
    whenIdle: () => current?.done ?? Promise.resolve(),
  };
}
