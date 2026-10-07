// 原型过渡期的连接：接了真数据的频道走真连接（连守护进程的 WebSocket），其余频道仍走原型的假连接。
// 04 号票起秘书会话是真的；06 号票起卡片、待我处理和看板上的简单提醒也是真的；12 号票起看板上的任务、活动状态也是真的；
// 维护者会话（13、16）……由各自的票挪到真连接，全部挪完后删掉这个文件，App.tsx 直接用真连接。
//
// 卡片频道接了真数据之后，原型里别的页面（任务详情里的计划卡、配对批准页……）还要用假卡片：
// 假卡片换到一个只属于原型的频道名上推给状态层（序号不和真的卡片频道混），点它们的按钮仍交给假连接。
import type { CardActionRequest, Connection, InboxActionRequest, RevokeDeviceRequest, SendMessageRequest, StartTaskRequest } from "../app/connection.ts";
import { CHANNELS, type UiInput } from "../state/index.ts";
import type { FakeConnection } from "./fake-connection.ts";

/** 卡片频道接了真数据之后，原型的假卡片走的频道名 */
export const PROTO_CARDS_CHANNEL = "proto:cards";

export class SplitConnection implements Connection {
  private readonly real: Connection;
  private readonly fake: FakeConnection;
  private readonly realChannels: ReadonlySet<string>;

  constructor(real: Connection, fake: FakeConnection, realChannels: readonly string[]) {
    this.real = real;
    this.fake = fake;
    this.realChannels = new Set(realChannels);
  }

  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void {
    const pick = (real: boolean) => Object.fromEntries(Object.entries(cursors).filter(([c]) => this.realChannels.has(c) === real));
    const offReal = this.real.connect(pick(true), deliver);
    const offFake = this.fake.connect(pick(false), (input) => {
      if (input.kind === "frame" && this.realChannels.has(input.frame.channel)) {
        if (input.frame.channel === CHANNELS.cards) deliver({ kind: "frame", frame: { ...input.frame, channel: PROTO_CARDS_CHANNEL } });
        // 别的接了真数据的频道（秘书会话、待我处理……）的假历史不要了
        return;
      }
      deliver(input);
    });
    return () => {
      offReal();
      offFake();
    };
  }

  sendMessage(req: SendMessageRequest): void {
    (this.realChannels.has(req.conversation) ? this.real : this.fake).sendMessage(req);
  }

  /** 原型的假卡片交给假连接，其余的（守护进程推来的）交给真连接 */
  cardAction(req: CardActionRequest): void {
    (this.realChannels.has(CHANNELS.cards) && !this.fake.hasCard(req.cardId) ? this.real : this.fake).cardAction(req);
  }

  inboxAction(req: InboxActionRequest): void {
    (this.realChannels.has(CHANNELS.inbox) ? this.real : this.fake).inboxAction(req);
  }

  revokeDevice(req: RevokeDeviceRequest): void {
    (this.realChannels.has(CHANNELS.devices) ? this.real : this.fake).revokeDevice(req);
  }

  startTask(req: StartTaskRequest): void {
    (this.realChannels.has(CHANNELS.board) ? this.real : this.fake).startTask(req);
  }
}
