// 原型过渡期的连接：接了真数据的频道走真连接（连守护进程的 WebSocket），其余频道仍走原型的假连接。
// 04 号票起秘书会话是真的；卡片（06）、看板（12）、维护者会话（13、16）……由各自的票挪到真连接，
// 全部挪完后删掉这个文件，App.tsx 直接用真连接。
import type { CardActionRequest, Connection, SendMessageRequest } from "../app/connection.ts";
import type { UiInput } from "../state/index.ts";

export class SplitConnection implements Connection {
  private readonly real: Connection;
  private readonly fake: Connection;
  private readonly realChannels: ReadonlySet<string>;

  constructor(real: Connection, fake: Connection, realChannels: readonly string[]) {
    this.real = real;
    this.fake = fake;
    this.realChannels = new Set(realChannels);
  }

  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void {
    const pick = (real: boolean) => Object.fromEntries(Object.entries(cursors).filter(([c]) => this.realChannels.has(c) === real));
    const offReal = this.real.connect(pick(true), deliver);
    // 假连接里这些频道的假历史不要了
    const offFake = this.fake.connect(pick(false), (input) => {
      if (input.kind === "frame" && this.realChannels.has(input.frame.channel)) return;
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

  /** 卡片还是假的（06 号票接真数据） */
  cardAction(req: CardActionRequest): void {
    this.fake.cardAction(req);
  }
}
