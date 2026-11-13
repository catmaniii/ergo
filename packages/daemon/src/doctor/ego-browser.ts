// 体检"二狗本身"里的"ego 浏览器"（466）：agent 用的浏览器是用户电脑上的 ego lite（ego-browser 命令）。
// - 找不找得到命令（web/ego-browser.ts 的探测，和拉起 agent 时同一份），找到了报路径和 `ego-browser --version` 的版本；
// - ego lite 开没开（进程快照里有它的 ego.exe）。
// 没装 → 注意，告诉用户去哪装；装了没开 → 注意，告诉用户打开就行（agent 用它时也会先请用户打开，不自己去拉起）；
// 开着 → 正常；看不了开没开（不是 Windows）→ 正常，只报路径和版本。
// cost 是 local：要起一次 `ego-browser --version`（按文件 + 修改时间记住，文件没变不再起），超时放到它的等待时长加一秒。
import { EGO_LITE_URL, EGO_VERSION_TIMEOUT_MS, type EgoBrowserFound } from "../web/index.ts";
import { t } from "@ergo/protocol";
import type { DoctorCheck, DoctorFinding } from "./checks.ts";

/** 体检看到的 ego 浏览器 */
export interface EgoBrowserFacts {
  /** 找到的命令和它的版本（读不出来没有）；没装是 undefined */
  found: { path: string; version?: string } | undefined;
  /** ego lite 开没开；看不了（不是 Windows、快照出错）是 undefined */
  running: boolean | undefined;
}

export function judgeEgoBrowser(facts: EgoBrowserFacts): DoctorFinding {
  if (!facts.found) return { level: "warn", fact: { key: "doctor.egoBrowser.missing" }, fix: { key: "doctor.fix.egoBrowserMissing", params: { url: EGO_LITE_URL } } };
  const params = { path: facts.found.path, version: facts.found.version ?? t("doctor.egoBrowser.versionUnknown") };
  if (facts.running === false) return { level: "warn", fact: { key: "doctor.egoBrowser.notRunning", params }, fix: { key: "doctor.fix.egoBrowserNotRunning" } };
  return { level: "ok", fact: { key: facts.running === true ? "doctor.egoBrowser.running" : "doctor.egoBrowser.found", params } };
}

/** 体检项：find 现找（和拉起 agent 同一份探测），version 读版本，running 看 ego lite 开没开 */
export function egoBrowserCheck(sources: { find(): EgoBrowserFound | undefined; version(file: string): Promise<string | undefined>; running(): boolean | undefined }): DoctorCheck {
  return {
    id: "ego-browser",
    title: "doctor.check.egoBrowser.title",
    cost: "local",
    timeoutMs: EGO_VERSION_TIMEOUT_MS + 1_000,
    run: async () => {
      const found = sources.find();
      if (!found) return judgeEgoBrowser({ found: undefined, running: undefined });
      const version = await sources.version(found.path);
      return judgeEgoBrowser({ found: { path: found.path, ...(version === undefined ? {} : { version }) }, running: sources.running() });
    },
  };
}
