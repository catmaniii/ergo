// 首次设置向导（319 号票，用户 2026-10-27 定："只做网页前端，不做终端 ergo onboard"）。
// 向导在网页上一步一步走完：① 语言/称呼/助手名 ② 模型 Key ③ 组件（记忆的向量模型）④ 手机配对 ⑤ 安全默认值说明。
// 前端要知道"哪几步做完了"才能显示进度、决定从哪一步接着走，所以守护进程给两个接口（路径在 http.ts）：
// - GET /api/setup：五步各自的状态（SetupView）；
// - POST /api/setup：标一步"以后再说"（skip）或者"看过了/做完了"（SetupMarkBody）。
// 真相是数据目录的配置文件 config/ergo.json 的 setup 节（守护进程写），改了马上生效、不用重启；这一份只是形状。
// 不引用 TypeBox：网页只用常量和类型，打包时不会把 schema 带进网页（请求体的 schema 在 setup-schema.ts）。

/** 向导的五步，顺序就是网页上先后的顺序 */
export const SETUP_STEPS = ["language", "model", "components", "phone", "safety"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

/** 一步现在的样子（GET /api/setup 里 steps 的一项） */
export interface SetupStepView {
  id: SetupStepId;
  /** 条件本来就满足（比如已经填了 key、已经配对过设备），或者用户点了"以后再说" */
  done: boolean;
  /** 条件现在是不是满足（用户点"以后再说"不影响这个） */
  ready: boolean;
  /** 这一步可以不配（现在的五步都是可选，但先留这个字段） */
  optional: boolean;
}

/** GET /api/setup：五步的状态和全部做完没有 */
export interface SetupView {
  steps: SetupStepView[];
  /** 全部做完（含"以后再说"） */
  complete: boolean;
}

/** POST /api/setup：标"以后再说"（skip: true）或者标"看过了/做完了"（skip 不给或 false） */
export interface SetupMarkBody {
  step: SetupStepId;
  skip?: boolean;
}
