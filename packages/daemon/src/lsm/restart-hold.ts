// 秘书让服务管家"等二狗空闲了重启二狗"之后（418 的 lsm_restart_self）：从排上起、到秘书这一轮说完（秘书会话的 turn_end）之前，
// 报给服务管家的"忙"里多一条，免得工具一返回、这次调用一结束就不忙了，二狗在秘书回话的半截停掉（那条输入会被记成中断，
// 用户看到"上一条消息处理时中断了"）。这一轮说完就放开；万一一直等不到（回合卡住），最多等 maxMs 也放开——不挡重启。
// 只多报忙，不改服务管家那边的规矩（它照样一小时等不到空闲就撤）。组合根（daemon.ts）把它并进报给服务管家的忙不忙，
// 秘书会话的事件、放开时都补一次心跳。
import { CHANNELS, EVENT_TYPES, t } from "@ergo/protocol";
import type { StoredEvent } from "../events/event-store.ts";
import type { LsmBusy } from "./link.ts";

/** 默认最多等多久（毫秒）：秘书这一轮正常几十秒就说完 */
export const RESTART_HOLD_MAX_MS = 5 * 60_000;

export interface RestartSelfHold {
  /** 排上了"等空闲重启"：从现在起到秘书这一轮说完，算忙 */
  begin(): void;
  /** 没排上（服务管家拒了、没回）：撤掉 */
  cancel(): void;
  /** 现在在不在等 */
  readonly active: boolean;
  /** 这一条事件是秘书这一轮说完：放开（放开了回 true） */
  release(event: StoredEvent): boolean;
  /** 开始、放开、撤掉时（补一次心跳）；返回取消订阅 */
  onChange(listener: () => void): () => void;
}

export function createRestartSelfHold(options: { maxMs?: number } = {}): RestartSelfHold {
  const maxMs = options.maxMs ?? RESTART_HOLD_MAX_MS;
  let timer: NodeJS.Timeout | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const stop = () => {
    if (!timer) return false;
    clearTimeout(timer);
    timer = undefined;
    changed();
    return true;
  };
  return {
    begin() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(stop, maxMs);
      timer.unref();
      changed();
    },
    cancel: () => void stop(),
    get active() {
      return timer !== undefined;
    },
    release(event) {
      if (!timer || event.channel !== CHANNELS.secretary || event.type !== EVENT_TYPES.turnEnd) return false;
      return stop();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** 报给服务管家的忙不忙并上"等秘书说完这一轮"（原因接在后面） */
export function withRestartHold(busy: LsmBusy, hold: Pick<RestartSelfHold, "active">): LsmBusy {
  if (!hold.active) return busy;
  const reason = t("lsm.busy.restartHold");
  return { busy: true, reason: busy.busy && busy.reason ? `${busy.reason}${t("lsm.busy.reasonSep")}${reason}` : reason };
}
