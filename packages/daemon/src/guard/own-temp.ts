// 临时文件（111 号票，用户 2026-10-13 定："覆盖和删除的限制，只对系统已有的资源、数据、配置以及项目阶段交付件。
// 如果是任务中间的临时文件和脚本，以及为了生成每个项目阶段交付件临时生成的脚本和数据，默认可以修改或者删除，不要每次都问我或者拦住了"；
// 又补充"任务和项目的临时文件都是一样的啊，不是光是任务，也包括项目"）。
// 删除、整体重写临时文件不落入"删除或覆盖"（judge.ts 的 pathRule），也不受 v1 模板"删除或覆盖之前必须已备份或已提交"约束
// （规则看到的路径上 ownTemp 为真，rule-templates.ts）。按发起调用的 agent 所属的范围认：项目里按项目（项目开始之后生成的都算，
// 不要求是哪一个任务、哪一张工单建的），项目外的任务按这个任务（GuardOwnWork，调用方给）。纯函数：调用方给 GuardInput.ownWork
// （范围开始的时间、交付件）和环境事实（文件的创建时间、要删除的目录里面有什么），效果日志按时序规则的范围看。
// 一个路径算临时文件，要同时满足：
// 1. 在 agent 本来就能写的工作目录里（项目档案一律不算），真实路径（符号链接、目录联接）也在里面；工作目录本身、
//    .git 和它里面的东西不算（系统建的：开发类项目确认立项书时才 git init，创建时间晚于开始，删了提交历史就回不来）；
// 2. 是范围开始之后才有的：效果日志里有一次调用新建了它（EffectRecord.created：写之前它不存在），或者它的创建时间
//    （FileFact.createdAt）晚于范围开始——脚本里间接生成、守卫没看见的，前几个阶段、前几次运行、前几张工单建的都认得出；
// 3. 不是交付件：交出去了的阶段的交付件写到的路径（和它们里面的东西）；产出区里、交付件认不出路径时工作目录里，
//    最近一次交出去时已经有了的；
// 4. 是目录的（递归删除）：里面的东西也都得满足 1～3，列不全的（太多、有链接、没给）不算；带通配符的：展开成的每一个都得满足，
//    展不开的不算。
// 认不出的（路径没法确定、没有环境事实、创建时间读不到又没有效果日志的记录）按"已有的"算。
// 另外，agent 的 bash 的临时目录（177 号票：工作目录里的 .ergo-tmp，TMPDIR 指到它）里的东西一律算临时文件——不看是谁、什么时候建的，
// 也不算交付件；真实路径（链接）指到外面的、要删的目录里有链接的不算。秘书没有。
import { win32 } from "node:path";
import { wildcardPrefix } from "./bottom-line-risk.ts";
import { comparable, isWithin, isWithinAny, resolveAgentPath, type ShellEnv } from "./paths.ts";
import type { EffectRecord, FileFact, GuardInput, GuardOwnWork } from "./types.ts";

/** agent 的 bash 的临时目录名（177 号票）：在工作目录里，TMPDIR、TEMP、TMP 指到它（agent-manager/work-temp.ts） */
export const WORK_TEMP_DIR = ".ergo-tmp";

/** 一处交付件：落在 path 里（就是它或在它里面）的；before 给了的只算那个时刻已经有了的 */
interface Delivered {
  path: string;
  before?: number;
}

/**
 * 认临时文件的函数（参数是规范化后的绝对路径，带通配符的按展开成的算）。没给 ownWork、秘书、没有工作目录的一律 false。
 * inScope 是效果日志的范围（和时序规则同一个：任务里同一个任务的，不属于任务的同一个 agent、同一段会话的）
 */
export function ownTempTest(input: GuardInput, env: ShellEnv, inScope: (e: EffectRecord) => boolean): (path: string) => boolean {
  const own = input.ownWork;
  const agent = input.agent;
  if (agent.kind === "secretary" || agent.workingDirs.length === 0) return () => false;
  const files = new Map(Object.entries(input.facts.files ?? {}).map(([k, v]) => [comparable(k), v]));
  const inWorkTemp = workTempTest([agent.cwd, ...agent.workingDirs], files);
  if (!own) return inWorkTemp;
  const roots = agent.workingDirs;
  const wildcards = new Map(Object.entries(input.facts.wildcards ?? {}).map(([k, v]) => [comparable(k), v]));
  // 效果日志里新建它的那次（最早的一次）
  const created = new Map<string, number>();
  for (const e of input.effectLog) {
    if (!inScope(e)) continue;
    for (const p of e.created ?? []) if (!created.has(comparable(p))) created.set(comparable(p), e.at);
  }
  const delivered = deliveredOf(own, [env.cwd, ...roots], env);

  /** 范围开始之后什么时候有的；认不出是 undefined */
  const bornAt = (path: string, createdAt: number | undefined): number | undefined =>
    created.get(comparable(path)) ?? (createdAt !== undefined && createdAt > own.startedAt ? createdAt : undefined);
  const isDelivered = (path: string, born: number) => delivered.some((d) => isWithin(path, d.path) && (d.before === undefined || born <= d.before));
  /**
   * 系统建的：工作目录本身、git 仓库（.git 和它里面的）——项目开始之后才建（开发类项目确认立项书时才 git init），
   * 创建时间晚于开始，但删了提交历史就回不来，一律按已有的算
   */
  const isSystemMade = (path: string) =>
    roots.some((r) => isWithin(path, r) && (comparable(path) === comparable(r) || comparable(win32.relative(r, path)).split("\\").includes(".git")));
  /** 一个路径（和它的真实路径）在工作目录里、范围开始之后才有、不是交付件 */
  const fresh = (path: string, fact: Pick<FileFact, "createdAt" | "realPath"> | undefined): boolean => {
    const born = bornAt(path, fact?.createdAt);
    if (born === undefined) return false;
    const targets = fact?.realPath === undefined ? [path] : [path, fact.realPath];
    return targets.every((t) => isWithinAny(t, roots) && !isSystemMade(t) && !isDelivered(t, born));
  };
  const one = (path: string): boolean => {
    const fact = files.get(comparable(path));
    // 没有环境事实的：不知道在不在、是文件还是目录，按已有的算
    if (!fact?.exists || !fresh(path, fact)) return false;
    if (!fact.isDirectory) return true;
    const contents = fact.contents;
    return contents !== undefined && contents.complete && contents.entries.every((e) => fresh(e.path, e));
  };
  return (path) => {
    if (inWorkTemp(path)) return true;
    const prefix = wildcardPrefix(path);
    if (prefix === undefined) return one(path);
    const matches = (wildcards.get(comparable(path)) ?? []).filter((m) => comparable(m) !== comparable(prefix));
    return matches.length > 0 && matches.every(one);
  };
}

/** 在 agent 的 bash 的临时目录里（带通配符的按写法看：展开成的都在这个目录下）；真实路径指到外面的、要删的目录里有链接的不算 */
function workTempTest(workDirs: readonly string[], files: ReadonlyMap<string, FileFact>): (path: string) => boolean {
  const temps = workDirs.map((d) => win32.join(d, WORK_TEMP_DIR));
  return (path) => {
    if (!isWithinAny(path, temps)) return false;
    const fact = files.get(comparable(path));
    if (fact?.realPath !== undefined && !isWithinAny(fact.realPath, temps)) return false;
    return !(fact?.isDirectory && fact.contents !== undefined && !fact.contents.complete);
  };
}

/**
 * 交付件：交出去了的阶段的交付件写到的路径（相对路径按 agent 的工作目录和每个工作目录各解析一遍，宁可多算），不论什么时候建的；
 * 按交出去的时间认的（产出区，交付件认不出路径时连同工作目录）那时已经有了的
 */
function deliveredOf(own: GuardOwnWork, bases: readonly string[], env: ShellEnv): Delivered[] {
  const out: Delivered[] = [];
  const dirs = [...new Map(bases.map((b) => [comparable(b), b])).values()];
  for (const raw of own.deliverables) {
    for (const cwd of dirs) {
      const resolved = resolveAgentPath(raw, { ...env, cwd });
      if (resolved.kind === "absolute") out.push({ path: resolved.path });
    }
  }
  for (const h of own.handovers) {
    for (const dir of h.dir === undefined ? dirs : [h.dir]) out.push(h.at === undefined ? { path: dir } : { path: dir, before: h.at });
  }
  return out;
}
