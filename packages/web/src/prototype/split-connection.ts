// 原型过渡期的连接：接了真数据的频道走真连接（连守护进程的 WebSocket），其余频道仍走原型的假连接。
// 04 号票起秘书会话是真的；06 号票起卡片、待我处理和看板上的简单提醒也是真的；12 号票起看板上的任务、活动状态也是真的；
// 15 号票起项目列表是真的（真项目的维护者会话在打开时订阅，watchChannels）；任务的维护者会话（13、16）……由各自的票挪到真连接，全部挪完后删掉这个文件，App.tsx 直接用真连接。
//
// 卡片频道接了真数据之后，原型里别的页面（任务详情里的计划卡、配对批准页……）还要用假卡片：
// 假卡片换到一个只属于原型的频道名上推给状态层（序号不和真的卡片频道混），点它们的按钮仍交给假连接。
import type {
  CardActionRequest,
  Connection,
  ConvertTaskRequest,
  InboxActionRequest,
  NewProjectRequest,
  ProjectActionRequest,
  RescheduleJobRequest,
  ResetMaintainerRequest,
  RetryVoiceRequest,
  SetToolkitRequest,
  RevokeDeviceRequest,
  ScheduledJobActionRequest,
  SendMessageRequest,
  StartTaskRequest,
  CreateReminderRequest,
  TaskActionRequest,
  TaskBatchActionRequest,
  UpdateWatchCategoriesRequest,
} from "../app/connection.ts";
import { CHANNELS, type RescheduleJobResult, type TaskBatchActionResult, type UiInput } from "../state/index.ts";
import { FAKE_VOICE_PREFIX, type FakeConnection } from "./fake-connection.ts";

/** 卡片频道接了真数据之后，原型的假卡片走的频道名 */
export const PROTO_CARDS_CHANNEL = "proto:cards";

export class SplitConnection implements Connection {
  private readonly real: Connection;
  private readonly fake: FakeConnection;
  private readonly realChannels: Set<string>;

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

  taskAction(req: TaskActionRequest): void {
    (this.realChannels.has(CHANNELS.board) && !req.taskId.startsWith("t-proto-") ? this.real : this.fake).taskAction(req);
  }

  /** 一次处理多个任务（90 号票）：和单个的一样，看板接了真数据就交给真连接 */
  taskBatchAction(req: TaskBatchActionRequest): Promise<TaskBatchActionResult> {
    return (this.realChannels.has(CHANNELS.board) ? this.real : this.fake).taskBatchAction(req);
  }

  /** 原型的假语音（v-fake-）交给假连接，其余的交给真连接（语音在会话频道上，秘书会话接了真数据） */
  retryVoice(req: RetryVoiceRequest): void {
    (this.realChannels.has(CHANNELS.secretary) && !req.voiceId.startsWith(FAKE_VOICE_PREFIX) ? this.real : this.fake).retryVoice(req);
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

  /** 简单提醒在看板频道上：看板接了真数据就交给真连接 */
  createReminder(req: CreateReminderRequest): void {
    (this.realChannels.has(CHANNELS.board) ? this.real : this.fake).createReminder(req);
  }

  updateWatchCategories(req: UpdateWatchCategoriesRequest): void {
    (this.realChannels.has(CHANNELS.watchCategories) ? this.real : this.fake).updateWatchCategories(req);
  }

  newProject(req: NewProjectRequest): void {
    (this.realChannels.has(CHANNELS.projects) ? this.real : this.fake).newProject(req);
  }

  convertTaskToProject(req: ConvertTaskRequest): void {
    (this.realChannels.has(CHANNELS.projects) ? this.real : this.fake).convertTaskToProject(req);
  }

  projectAction(req: ProjectActionRequest): void {
    (this.realChannels.has(CHANNELS.projects) ? this.real : this.fake).projectAction(req);
  }

  /** 定时作业在看板频道上（19 号票）：看板接了真数据就交给真连接 */
  scheduledJobAction(req: ScheduledJobActionRequest): void {
    (this.realChannels.has(CHANNELS.board) ? this.real : this.fake).scheduledJobAction(req);
  }

  /** 改时间（98 号票）：和暂停、恢复、取消一样跟着看板 */
  rescheduleJob(req: RescheduleJobRequest): Promise<RescheduleJobResult> {
    return (this.realChannels.has(CHANNELS.board) ? this.real : this.fake).rescheduleJob(req);
  }

  resetMaintainer(req: ResetMaintainerRequest): void {
    (this.realChannels.has(CHANNELS.projects) ? this.real : this.fake).resetMaintainer(req);
  }

  /** 改工具包：项目的跟着项目列表、任务的跟着看板（原型的假任务交给假连接） */
  setToolkit(req: SetToolkitRequest): void {
    const real = req.target.kind === "project" ? this.realChannels.has(CHANNELS.projects) : this.realChannels.has(CHANNELS.board) && !req.target.taskId.startsWith("t-proto-");
    (real ? this.real : this.fake).setToolkit(req);
  }

  /**
   * 多订阅（打开一个真项目的维护者会话）：项目列表接了真数据时，项目的维护者会话也是真的，交给真连接、
   * 记成接了真数据的频道（发消息走真连接）；原型假项目的维护者会话由假连接一直推着
   */
  watchChannels(channels: readonly string[]): void {
    if (!this.realChannels.has(CHANNELS.projects)) return;
    for (const c of channels) this.realChannels.add(c);
    this.real.watchChannels(channels);
  }
}
