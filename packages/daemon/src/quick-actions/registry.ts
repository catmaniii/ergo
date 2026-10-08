// 快速动作的执行器注册表（规格第 14 节）：执行器按动作类型登记。每种动作类型写明
// - 秘书在"提议快速动作"工具里给的参数：自带 schema（参照卡片动作的 input），运行时先按它校验再交给 normalize；
// - 怎么规范化（存进卡片和操作记录的参数、一句话的标题、展示用的对象和内容）；
// - "明确点了"的判定（explicit）：执行器自己声明，用 explicit.ts 的共用辅助函数；不写就永远算推断；
// - 关注（watch）：形状同工具注册表的登记（类别、底线、"做完告诉我"、参数规则、是否对外发送）。运行时把动作作为一个
//   伪工具调用（quick_action:<动作类型>，参数就是规范化后的参数）交给守卫的类别匹配，用户的自定义类别也能匹配到它；
// - 确认规则：按关注类别判（默认）、推断出来时一律先问（记住；22 号票的任务控制）、总要用户核对（记忆删除）；
// - 怎么执行：直接给出要和操作记录同一事务追加的事件（不拉起 agent、不上任务看板、不占并发名额）。
// 本票登记记忆命令（memory/）；任务控制（22）、调用已授权的 MCP 工具（27）照这个加：只加一个 defineQuickAction 的登记，
// 在 daemon.ts 里 register。
import { type CardType, schemaChecker, type Static, type TSchema } from "@ergou/protocol";
import type { NewEvent, PurgeRewrite } from "../events/event-store.ts";
import type { ArgRule, BottomLineId, BuiltinCategoryId } from "../guard/index.ts";
import type { JsonValue } from "../runtime/index.ts";
import type { ExplicitFinding, UserTurn } from "./explicit.ts";

/** 规范化后的动作 */
export interface NormalizedQuickAction {
  /** 规范化后的参数（存进卡片和操作记录，执行时原样交回 execute；也是交给类别匹配的伪工具调用的参数） */
  params: JsonValue;
  /** 一句话（"记住：下周三上午体检"） */
  title: string;
  /** 展示用的对象、内容 */
  target?: string;
  content?: string;
}

/** 执行时拿到的 */
export interface QuickActionContext {
  actionId: string;
  /** 对应的卡片（快速动作卡或记忆删除卡） */
  cardId: string;
  /** 动作是在哪个会话里提出的（操作记录追加在这里） */
  conversation: string;
  /** 秘书当时在处理的那条用户消息 */
  inputMessageId?: string;
  /** 用户这一轮明确点了对象和内容（运行时判定的），以及内容是在哪里点明的；推断出来、用户在卡上确认的没有 */
  explicit?: ExplicitFinding;
}

/** 执行的结果 */
export interface QuickActionOutcome {
  /** 和操作记录、卡片更新同一事务追加的事件 */
  events: NewEvent[];
  /** 结果说明（写进卡片和操作记录，也回给秘书） */
  summary: string;
  /** 彻底删除：同一事务里改写的事件。只有记忆命令"彻底删除"会给 */
  purge?: PurgeRewrite[];
  /** 事件（连同卡片、操作记录）落盘之后叫一次（任务控制：执行控制器落盘之后的事，22 号票） */
  afterCommit?: () => void;
}

/** 动作提出来时出的卡（不给就是快速动作卡）：记忆删除出记忆删除卡 */
export interface ProposalCard {
  type: CardType;
  payload: unknown;
  /** 待我处理里的标题 */
  inboxTitle: string;
}

/** 关注：形状同工具注册表的登记（伪工具 quick_action:<动作类型> 的登记） */
export interface QuickActionWatch {
  /** 落入的内置关注类别 */
  categories: readonly BuiltinCategoryId[];
  /** 底线（付款、建账户、改密码……）：点没点明都照样管 */
  bottomLines?: readonly BottomLineId[];
  /** 做完告诉我 */
  notifyWhenDone?: boolean;
  /** 规范化后的参数里，哪些要交给类别匹配看（收件人、金额、路径……；自定义类别按它们匹配） */
  args?: Readonly<Record<string, ArgRule>>;
  /** 会把参数里的内容发出去（检查对外内容里的密钥形态） */
  outbound?: boolean;
}

export interface QuickActionExecutor<S extends TSchema = TSchema> {
  /** 动作类型（唯一，秘书在工具里写的就是它） */
  type: string;
  /** 中文名 */
  title: string;
  /** 给秘书看的用法（写进"提议快速动作"工具的说明） */
  usage: string;
  /** 秘书给的参数的 schema（"提议快速动作"工具的 params） */
  params: S;
  watch: QuickActionWatch;
  /**
   * 确认规则：
   * - by_category（默认）：明确点了直接执行，推断出来的按关注类别的对话处置判；
   * - ask_when_inferred：推断出来的一律先问（不看类别），明确点了直接执行；
   * - always：总要用户核对后执行（记忆删除：要删哪些素材是秘书检索出来的，不是用户点明的）
   */
  confirm?: "by_category" | "ask_when_inferred" | "always";
  /** 规范化（参数已按 params 校验过）；参数不对就抛错，错误的说明原样回给秘书 */
  normalize(params: Static<S>): NormalizedQuickAction;
  /** 用户这一轮有没有明确点了对象和内容（运行时判定，用 explicit.ts 的辅助函数）；不写就永远算推断 */
  explicit?(action: NormalizedQuickAction, turn: UserTurn): ExplicitFinding | undefined;
  /** 要用户确认时出的卡（不给就是快速动作卡） */
  proposalCard?(action: NormalizedQuickAction, context: Omit<QuickActionContext, "cardId" | "explicit">): ProposalCard;
  /** 执行。不让做（比如素材已经不在了）就抛 RequestRejected，卡片保持待处理 */
  execute(params: unknown, context: QuickActionContext): QuickActionOutcome;
}

/** 登记好的执行器：秘书给的参数先按它自带的 schema 校验 */
export interface RegisteredQuickAction extends QuickActionExecutor {
  /** 校验参数再规范化；不合 schema 时抛错（说明回给秘书） */
  normalizeChecked(params: unknown): NormalizedQuickAction;
}

/** 定义一种快速动作（类型推导用：normalize 拿到的参数类型由 params 的 schema 推出） */
export function defineQuickAction<S extends TSchema>(executor: QuickActionExecutor<S>): QuickActionExecutor {
  return executor as unknown as QuickActionExecutor;
}

export class QuickActionRegistry {
  private readonly executors = new Map<string, RegisteredQuickAction>();

  /** 登记一种动作；同一类型登记两次报错（测试替换用 replace） */
  register(executor: QuickActionExecutor, options: { replace?: boolean } = {}): void {
    if (this.executors.has(executor.type) && !options.replace) throw new Error(`快速动作 ${executor.type} 已经登记过了`);
    const checker = schemaChecker(executor.params);
    this.executors.set(executor.type, {
      ...executor,
      normalizeChecked(params) {
        if (!checker.check(params)) throw new Error(checker.firstError(params) ?? "参数不合 schema");
        return executor.normalize(params);
      },
    });
  }

  get(type: string): RegisteredQuickAction | undefined {
    return this.executors.get(type);
  }

  list(): RegisteredQuickAction[] {
    return [...this.executors.values()];
  }
}
