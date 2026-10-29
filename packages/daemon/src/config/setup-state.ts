// 首次设置向导（319 号票，用户 2026-10-27 定："只做网页前端，不做终端 ergo onboard"）：网页上五步
// ① 语言/称呼/助手名 ② 模型 Key ③ 组件（记忆的向量模型）④ 手机配对 ⑤ 安全默认值说明，哪几步做完了。
// 写法照 config/safety-settings.ts（315 号票）：
// - 真相是数据目录的配置文件 config/ergo.json 的 setup 节：{ format: 1, skipped: [...], done: [...] }。
//   用户在向导里点"以后再说"的写进 skipped、点"看过了/做完了"的写进 done，一步只待在一处；写回配置文件时
//   别的字段原样留着（writeSetupConfig），内存里也换掉、马上生效。手改配置文件照旧要重启才读到。
// - 各步的条件（ready）现算，但这个服务不自己去读别的服务：组合根把"这一步现在满不满足"的取值函数交进来
//   （我的名字、模型的 key、记忆的向量模型那个组件、至少配对过一台设备）。safety 没有条件，只能靠用户看过。
// - done = ready || 点了"以后再说" || 点了"做完了"；五步都 done 就是 complete。
// 没配过的老数据目录里没有这一节，按"什么都没做"（全 false），不写、不拦着用二狗。
import { SETUP_STEPS, type SetupMarkBody, type SetupStepId, type SetupStepView, type SetupView } from "@ergo/protocol";
import { type SetupConfig, writeSetupConfig } from "./config.ts";

/**
 * 各步条件现不满足的取值函数（由组合根注入）：五个步骤里除 safety 之外的四步。
 * safety 没有条件——用户看过了（或者点了"以后再说"）才算 done，所以没有它的取值函数
 */
export type SetupReadyProbes = Readonly<Record<Exclude<SetupStepId, "safety">, () => boolean>>;

export interface SetupStateService {
  /** 现在的（配置里的写法） */
  current(): SetupConfig;
  /** 给向导页的：五步各自的状态和全部做完没有 */
  view(): SetupView;
  /** 打标记：skip 为真写进 skipped（并从 done 里去掉），否则写进 done（并从 skipped 里去掉）；回打完之后的 */
  mark(body: SetupMarkBody): SetupView;
}

export interface SetupStateOptions {
  /** 数据目录里的配置文件 */
  configFile: string;
  /** 起来时从配置读到的（loadConfig 的 setup） */
  initial: SetupConfig;
  /** 各步的条件现在满不满足（每次 view 现取：用户可能刚刚填了 key、配对了手机） */
  ready: SetupReadyProbes;
  log: (line: string) => void;
}

export function createSetupState(options: SetupStateOptions): SetupStateService {
  // 拷贝一份：别把 loadConfig 交回来的那份配置改了
  let current: SetupConfig = { format: options.initial.format, skipped: [...options.initial.skipped], done: [...options.initial.done] };
  const view = (): SetupView => {
    const steps: SetupStepView[] = SETUP_STEPS.map((id) => {
      // 条件现算；safety 没有条件（只有用户看过了才算 done）
      const ready = id === "safety" ? false : options.ready[id]();
      return { id, done: ready || current.skipped.includes(id) || current.done.includes(id), ready, optional: true };
    });
    return { steps, complete: steps.every((step) => step.done) };
  };
  return {
    current: () => current,
    view,
    mark(body) {
      const skip = body.skip === true;
      const others = (ids: readonly SetupStepId[]) => ids.filter((id) => id !== body.step);
      const skipped = skip ? [...new Set([...current.skipped, body.step])] : others(current.skipped);
      const done = skip ? others(current.done) : [...new Set([...current.done, body.step])];
      writeSetupConfig(options.configFile, { format: current.format, skipped, done });
      current = { format: current.format, skipped, done };
      const next = view();
      // @i18n-ignore-next log：向导打了标记只进日志
      options.log(`设置向导：${body.step} 标成${skip ? "以后再说" : "做完了"}（五步里做完 ${next.steps.filter((step) => step.done).length} 步）`);
      return next;
    },
  };
}
