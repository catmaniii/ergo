// 设置里按会话或按时间段删除素材（规格第 15 节"入口"）：选一个会话或一个时间段，再选三种删除方式之一，
// 确认后对范围内的全部素材执行，效果和对话里的记忆删除一样（忘掉、彻底删除、别推断；同一个 deletionEvents）。
// 这是用户在设置里亲手选的范围，不过秘书、不出卡片；同样是素材频道上的一条 memory_command 事件（来源"设置"），
// 彻底删除同样改写原始事件、追加 messages_purged。请求带幂等键：同一个请求重发只执行一次。
import type { DeleteCommandPayload, MaterialScope, MaterialScopeSummary, MemoryDeleteMode } from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import type { Material, Materials } from "../materials/index.ts";
import { deletionEvents } from "./deletion.ts";
import type { PurgeDeps } from "./purge.ts";

export interface BulkMaterialDeletion {
  /** 范围里有几条素材（不给范围是全部），以及有素材的会话各有几条 */
  summary(scope?: MaterialScope): MaterialScopeSummary;
  /** 对范围内的全部素材执行一种删法，返回处理了几条 */
  delete(scope: MaterialScope, mode: MemoryDeleteMode, idempotencyKey: string): { count: number };
}

export interface BulkMaterialDeletionOptions extends PurgeDeps {
  materials: Materials;
}

const deleteKey = (idempotencyKey: string) => `materials-delete:${idempotencyKey}`;

export function createBulkMaterialDeletion(options: BulkMaterialDeletionOptions): BulkMaterialDeletion {
  const { store, materials } = options;

  const inScope = (scope: MaterialScope | undefined): Material[] => {
    if (scope === undefined) return materials.list();
    if (scope.kind === "conversation") return materials.list({ conversation: scope.conversation });
    const from = Date.parse(scope.from);
    const to = Date.parse(scope.to);
    if (Number.isNaN(from) || Number.isNaN(to)) throw new RequestRejected("bad_params", "时间段的起止时间不对");
    if (from > to) throw new RequestRejected("bad_params", "时间段的开始晚于结束");
    return materials.list().filter((m) => {
      const t = Date.parse(m.time);
      return t >= from && t <= to;
    });
  };

  return {
    summary(scope) {
      const counts = new Map<string, number>();
      for (const m of materials.list()) if (m.conversation !== null) counts.set(m.conversation, (counts.get(m.conversation) ?? 0) + 1);
      return { count: inScope(scope).length, conversations: [...counts].map(([conversation, count]) => ({ conversation, count })) };
    },
    delete(scope, mode, idempotencyKey) {
      // 同一个请求重发：回第一次的结果，不再执行
      const done = store.eventByIdempotencyKey(deleteKey(idempotencyKey));
      if (done) return { count: (done.payload as DeleteCommandPayload).materialIds.length };
      const found = inScope(scope);
      if (found.length === 0) return { count: 0 };
      const { events, purge } = deletionEvents(options, { mode, materials: found, from: { kind: "settings", scope }, idempotencyKey: deleteKey(idempotencyKey) });
      store.appendBatch(events, purge.length === 0 ? undefined : { purge });
      return { count: found.length };
    },
  };
}
