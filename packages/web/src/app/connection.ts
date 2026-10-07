// 前端和守护进程之间的连接（规格第 5 节）。界面只通过它收发：
// - 收：事件帧，连同失败的请求，一律变成状态层的输入（UiInput）交给 deliver；
// - 发：带幂等键的请求（发消息、对卡片做动作、对待我处理事项做动作、吊销已配对设备、发起任务、改关注类别设置）。
// 用哪个实现由 App.tsx 注入（StoreProvider 的 connection）：WebSocket 实现（ws-connection.ts），
// 原型的假实现（prototype/fake-connection.ts），过渡期按频道分流（prototype/split-connection.ts）。
import type { CardAction, ConversationId, InboxAction, MessagePart, UiInput, UpdateWatchCategoriesParams } from "../state/index.ts";

export interface SendMessageRequest {
  conversation: ConversationId;
  idempotencyKey: string;
  parts: MessagePart[];
}

/** 对卡片做动作：`{卡片 id, 动作, 期望版本, 幂等键}`；服务端按版本条件更新，先到先得 */
export interface CardActionRequest {
  cardId: string;
  action: CardAction;
  expectedVersion: number;
  idempotencyKey: string;
  /** 动作附带的说明（打回意见、勾掉了哪几项授权、选了哪些答案） */
  note?: string;
  /** 动作附带的结构化输入（比如改提醒的新时间） */
  input?: unknown;
}

/** 对待我处理事项做动作：标已读 / 未读、归档 / 取消归档、删除、处理通知（choice 是选的动作） */
export interface InboxActionRequest {
  itemIds: string[];
  action: InboxAction;
  choice?: string;
  idempotencyKey: string;
}

/** 吊销一台已配对设备：它的凭证立即失效，开着的 WebSocket 被服务端关掉 */
export interface RevokeDeviceRequest {
  deviceId: string;
  idempotencyKey: string;
}

/** 点"发起任务"按钮：写要做什么（第一行当标题），选涉及的项目（不选是不涉及项目）；服务端不经秘书判断直接建出任务（规划中），秘书接着澄清 */
export interface StartTaskRequest {
  request: string;
  projects: string[];
  idempotencyKey: string;
}

/** 设置页改关注类别（26 号票）：调严内置类别、新建 / 改 / 删自定义类别、修复坏了的设置文件、重新读文件；设置随后在关注类别频道推来 */
export interface UpdateWatchCategoriesRequest {
  params: UpdateWatchCategoriesParams;
  idempotencyKey: string;
}

export interface Connection {
  /**
   * 连上服务端：带上每个频道最后收到的序号，服务端补发缺失的事件。
   * 返回断开连接的函数。
   */
  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void;
  sendMessage(req: SendMessageRequest): void;
  cardAction(req: CardActionRequest): void;
  inboxAction(req: InboxActionRequest): void;
  revokeDevice(req: RevokeDeviceRequest): void;
  startTask(req: StartTaskRequest): void;
  updateWatchCategories(req: UpdateWatchCategoriesRequest): void;
}
