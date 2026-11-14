// 体检"二狗本身"里的"ego 浏览器"（466）：agent 用的浏览器是用户电脑上的 ego lite（ego-browser 命令）。
// - 找不找得到命令（web/ego-browser.ts 的探测，和拉起 agent 时同一份），找到了报路径和版本——版本从路径上看
//   （egoVersionFromPath：active_version_dir 解开链接后的目录名），看不出来就只报找到了；
// - ego lite 开没开（进程快照里有它的 ego.exe）。
// 没装 → 注意，告诉用户去哪装；装了没开 → 正常（466 返修：agent 要用时二狗会像用户自己打开那样替他打开，见 web/ego-open.ts），
// 只写一句没开着、agent 要用时二狗会打开；开着 → 正常；看不了开没开（不是 Windows）→ 正常，只报路径和版本。
// 体检**不起任何进程**（466 返修）：不跑 `ego-browser --version`——ego lite 没开着时它会不会去拉起 ego 没实测过，体检是守护进程
// 自己跑的，拉起来的 ego 就在二狗的 Job 里。所以 cost 是 passive：只看文件、路径和进程快照。
import { EGO_LITE_URL, type EgoBrowserFound, egoLiteRunning, egoVersionFromPath } from "../web/index.ts";
import type { DoctorCheck, DoctorFinding } from "./checks.ts";

/** 体检看到的 ego 浏览器 */
export interface EgoBrowserFacts {
  /** 找到的命令和它的版本（从路径上看不出来没有）；没装是 undefined */
  found: { path: string; version?: string } | undefined;
  /** ego lite 开没开；看不了（不是 Windows、快照出错）是 undefined */
  running: boolean | undefined;
}

export function judgeEgoBrowser(facts: EgoBrowserFacts): DoctorFinding {
  if (!facts.found) return { level: "warn", fact: { key: "doctor.egoBrowser.missing" }, fix: { key: "doctor.fix.egoBrowserMissing", params: { url: EGO_LITE_URL } } };
  const { path, version } = facts.found;
  const state = facts.running === true ? "running" : facts.running === false ? "notRunning" : "found";
  // 看得出版本的写版本；看不出来的只写找到了（另一组句子，不写"版本读不出来"）
  return { level: "ok", fact: version === undefined ? { key: `doctor.egoBrowser.${state}NoVersion`, params: { path } } : { key: `doctor.egoBrowser.${state}`, params: { path, version } } };
}

/** 体检项要的三样：find 现找（和拉起 agent 同一份探测），version 从路径上看版本，running 看 ego lite 开没开 */
export interface EgoBrowserSources {
  find(): EgoBrowserFound | undefined;
  version(found: EgoBrowserFound): string | undefined;
  running(): boolean | undefined;
}

/** 真的三样（守护进程用）：版本从路径上看、开没开看进程快照，都不起进程 */
export function realEgoBrowserSources(input: { find(): EgoBrowserFound | undefined; programDirs(): readonly string[] }): EgoBrowserSources {
  return { find: input.find, version: (found) => egoVersionFromPath(found), running: () => egoLiteRunning(input.programDirs()) };
}

/** 体检项 */
export function egoBrowserCheck(sources: EgoBrowserSources): DoctorCheck {
  return {
    id: "ego-browser",
    title: "doctor.check.egoBrowser.title",
    cost: "passive",
    run: () => {
      const found = sources.find();
      if (!found) return judgeEgoBrowser({ found: undefined, running: undefined });
      const version = sources.version(found);
      return judgeEgoBrowser({ found: { path: found.path, ...(version === undefined ? {} : { version }) }, running: sources.running() });
    },
  };
}
