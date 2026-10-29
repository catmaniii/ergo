// 主切面里等维护者安静下来（录给前端回放的事件流要确定，见 recording.ts）。几个 agent 同时干活时，看板频道上任务、作业的事件和
// token 合计、维护者会话里它自己的回复和新到的通知（回执、计划确认）谁先谁后每次不一样，满载时更明显。
// 先让前一个安静下来，再做下一个动作（确认计划、验收、拨时钟、在会话里催一句），事件流的先后就只由测试的动作决定。
import { maintainerChannel } from "@ergo/protocol";
import { pendingInputs, startedInputs } from "../../src/conversation/views.ts";
import type { TestDaemon } from "./daemon.ts";
import { waitUntil } from "./process.ts";

/**
 * 等这几个维护者安静下来：
 * - 会话里没有等着的、正在处理的输入（这一轮已经结束：最后一次模型调用记了账，turn_end 落了盘）；
 * - 项目维护者的工单段不在收尾中（范围审视在这一轮结束之后才做，它的用量、工单的结束和交给派单方的回执在那之后才落盘）。
 * 只等已经开始的事：先等到说明它在干活的事件（它的回复、交上来的卡片、工具调用的结果），再调这个。
 */
export async function settled(td: TestDaemon, ...maintainerIds: string[]): Promise<void> {
  const busy = () =>
    maintainerIds.filter((id) => {
      const channel = maintainerChannel(id);
      const inputs = pendingInputs(td.daemon.store.reader, channel).length + startedInputs(td.daemon.store.reader, channel).length;
      return inputs > 0 || td.daemon.workOrders.current(id)?.state === "closing";
    });
  await waitUntil(() => busy().length === 0, { timeoutMs: 60_000, describe: () => `${busy().join("、")} 还在处理输入或收尾` });
}
