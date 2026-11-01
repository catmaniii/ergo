// 服务管家的开机自启：设置向导"能力"那一步显示现在开没开、能开能关。这里只是形状，真的动计划任务在守护进程里，
// 走 ergo svc install-autostart / uninstall-autostart 同一套（packages/daemon/src/lsm/autostart-switch.ts）。
// 开机拉起哪些服务不在这里改：在服务管家的网页（managerUrl）或者 ergo svc autostart <id> on|off 里改。
// 不引用 TypeBox（请求体的 schema 在 autostart-schema.ts）。

/**
 * 现在怎样：on 开着（任务归这份安装）；off 没开；elsewhere 开着，但任务指着别处的服务管家（用的人自己装的，这里不碰）；
 * unknown 查不了；unsupported 这个系统没有这种任务（不是 Windows）
 */
export const AUTOSTART_STATES = ["on", "off", "elsewhere", "unknown", "unsupported"] as const;
export type AutostartState = (typeof AUTOSTART_STATES)[number];

/** GET /api/autostart */
export interface AutostartView {
  state: AutostartState;
  /** 现在不能从这里开关的原因（给人看的）；能开关是 undefined */
  cannotChange?: string;
  /** 服务管家的网页地址：自动拉起哪些服务在那里改 */
  managerUrl: string;
}
