// 安全和预算的两个开关（315 号票，用户 2026-10-27 定："风险和任务预算的事情，做成一个设置吧。默认收紧，如果用户觉得比较难受，它可以自己关掉"）：
// 先问我（配置 guard.conversationApprovals）、任务的预算（配置 tasks.thresholds.budgetControl）。设置 · 关注类别那一页上两个开关，
// 319 号票的设置向导复用同一对接口（GET / PUT /api/safety-settings）。
// - 真相是配置文件 config/ergo.json：起来时从配置读（loadConfig），设置里改了写回去（别的内容原样留着），同时换掉内存里的——
//   守卫、任务执行、项目的工单判定、系统提示都现取（组合根交给它们的是取值的 getter），改了马上生效、不用重启：
//   守卫下一次判定就按新的；预算下一次核对就按新的；秘书交下一条输入之前按新的系统提示重新拉起，维护者下次拉起时换。
//   手改配置文件照旧要重启才读到。
// - 新装时两样都开着（config.ts 的 writeFreshInstallDefaults），已有的数据目录里没写的照旧关着（代码里的默认值没变）。
import type { SafetySettingsBody, SafetySettingsView } from "@ergo/protocol";
import type { TaskThresholds } from "../tasks/thresholds.ts";
import { type SafetyConfig, writeSafetyConfig } from "./config.ts";

export interface SafetySettingsService {
  /** 现在的（配置的写法） */
  current(): SafetyConfig;
  /** 给设置页的 */
  view(): SafetySettingsView;
  /** 改哪项给哪项：写进配置文件、换掉内存里的，回改好之后的 */
  change(body: SafetySettingsBody): SafetySettingsView;
  /** 改了叫 listener（秘书据此按新的系统提示重新拉起）；返回取消订阅 */
  onChange(listener: () => void): () => void;
}

export function createSafetySettings(options: { configFile: string; initial: SafetyConfig; log: (line: string) => void }): SafetySettingsService {
  let current: SafetyConfig = { ...options.initial };
  const listeners = new Set<() => void>();
  const view = (): SafetySettingsView => ({ conversationApprovals: current.conversationApprovals === "on", budgetControl: current.budgetControl });
  return {
    current: () => current,
    view,
    change(body) {
      const next: SafetyConfig = {
        conversationApprovals: body.conversationApprovals === undefined ? current.conversationApprovals : body.conversationApprovals ? "on" : "off",
        budgetControl: body.budgetControl ?? current.budgetControl,
      };
      writeSafetyConfig(options.configFile, next);
      const changed = next.conversationApprovals !== current.conversationApprovals || next.budgetControl !== current.budgetControl;
      current = next;
      // @i18n-ignore-next log：改设置只进日志
      if (changed) options.log(`设置里改了：对话审批 ${next.conversationApprovals}，任务的预算控制 ${next.budgetControl ? "开" : "关"}`);
      if (changed) for (const listener of listeners) listener();
      return view();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 任务的阈值，预算控制那一项现取设置里的（别的照配置）：交给任务执行、维护者的系统提示 */
export function withLiveBudgetControl(thresholds: TaskThresholds, safety: Pick<SafetySettingsService, "current">): TaskThresholds {
  const live = { ...thresholds };
  Object.defineProperty(live, "budgetControl", { get: () => safety.current().budgetControl, enumerable: true });
  return live;
}
