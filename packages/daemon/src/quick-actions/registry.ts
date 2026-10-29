// 快速动作的执行器注册表（规格第 14 节）：执行器按动作类型登记。每种动作类型写明
// - 秘书在"提议快速动作"工具里给的参数：自带 schema（参照卡片动作的 input），运行时先按它校验再交给 normalize；
// - 怎么规范化（存进卡片和操作记录的参数、一句话的标题、展示用的对象和内容）；
// - "明确点了"的判定（explicit）：执行器自己声明，用 explicit.ts 的共用辅助函数；不写就永远算推断；
// - 关注（watch）：形状同工具注册表的登记（类别、底线、"做完告诉我"、参数规则、是否对外发送）。运行时把动作作为一个
//   伪工具调用（quick_action:<动作类型>，参数就是规范化后的参数）交给守卫的类别匹配，用户的自定义类别也能匹配到它；
// - 确认规则：按关注类别判（默认）、推断出来时一律先问（记住；22 号票的任务控制）、总要用户核对（记忆删除）；
// - 怎么执行（二选一，类型上分开）：当场做完的写 execute，直接给出要和操作记录同一事务追加的事件（不拉起 agent、不上任务看板、
//   不占并发名额）；要等外面回话的（27 号票：调用 MCP 工具，由守护进程转给 MCP 服务进程）写 perform（异步），结果写进卡片和操作记录。
// 关注也可以按这一个动作给（watchFor，27 号票：每个 MCP 工具登记了自己的类别、参数规则）。
// 本票登记记忆命令（memory/）；任务控制（22）、调用已授权的 MCP 工具（27）照这个加：只加一个 defineQuickAction 的登记，
// 在 daemon.ts 里 register。
import { type CardType, type QuickActionBasis, schemaChecker, type Static, type TSchema } from "@ergo/protocol";
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
  /** 凭什么执行的：用户点明的、推断出来但在已有授权内直接执行的、用户在卡上确认后（记进操作记录，25 号票） */
  basis: QuickActionBasis;
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
  /**
   * 283 号票：执行时另外建的卡（建卡的事件在 events 里），直接执行时跟在"已执行"卡后面出在聊天里
   * （直接写进档案的生日问一句要不要每年提醒）
   */
  cardIds?: string[];
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

/** 两种执行器共有的：参数、规范化、点明的判定、关注、确认规则、出什么卡 */
interface QuickActionExecutorBase<S extends TSchema> {
  /** 动作类型（唯一，秘书在工具里写的就是它） */
  type: string;
  /** 中文名 */
  title: string;
  /** 给秘书看的用法（写进"提议快速动作"工具的说明） */
  usage: string;
  /**
   * "提议快速动作"工具的说明里另加的一句（129 号票）：接在说明开头"……确认后才执行。"之后；几种动作写同一句只出现一次。
   * 记忆插件的忘掉、彻底删除、别推断用它说"先用 search_materials 检索"，插件停用时这句随动作一起没有
   */
  proposeHint?: string;
  /** 秘书给的参数的 schema（"提议快速动作"工具的 params） */
  params: S;
  watch: QuickActionWatch;
  /** 按这一个动作给的关注（不给就用 watch）：每个 MCP 工具登记了自己的类别、底线、参数规则（27 号票） */
  watchFor?(action: NormalizedQuickAction): QuickActionWatch;
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
  /**
   * 要用户确认时出的卡（不给就是快速动作卡）。toolCallId 是提出它的那次工具调用（281 号票：个人档案的核对卡记下它，
   * 彻底删除档案里的值时连同这次调用的记录、会话文件里的参数一起改写）
   */
  proposalCard?(action: NormalizedQuickAction, context: Omit<QuickActionContext, "cardId" | "explicit" | "basis"> & { toolCallId?: string }): ProposalCard;
}

/** 当场做完的执行器（记忆命令、任务控制） */
export interface SyncQuickActionExecutor<S extends TSchema = TSchema> extends QuickActionExecutorBase<S> {
  /** 执行。不让做（比如素材已经不在了）就抛 RequestRejected，卡片保持待处理 */
  execute(params: unknown, context: QuickActionContext): QuickActionOutcome;
  perform?: never;
}

/** 异步执行的结果：一句话的说明、成没成（没做成的照样记进卡片和操作记录） */
export interface QuickActionPerformed {
  summary: string;
  ok: boolean;
}

/**
 * 要等外面回话的执行器（27 号票：调用 MCP 工具）：结果写进卡片和操作记录。点明了直接执行的，卡片在结果回来之后才出现；
 * 在卡上确认的，卡先记成已处理，结果回来后补上
 */
export interface AsyncQuickActionExecutor<S extends TSchema = TSchema> extends QuickActionExecutorBase<S> {
  perform(params: unknown, context: QuickActionContext): Promise<QuickActionPerformed>;
  execute?: never;
}

export type QuickActionExecutor<S extends TSchema = TSchema> = SyncQuickActionExecutor<S> | AsyncQuickActionExecutor<S>;

/** 是要等外面回话的执行器 */
export function isAsyncQuickAction<S extends TSchema>(executor: QuickActionExecutor<S>): executor is AsyncQuickActionExecutor<S> {
  return typeof executor.perform === "function";
}

/** 登记好的执行器：秘书给的参数先按它自带的 schema 校验 */
export type RegisteredQuickAction = QuickActionExecutor & {
  /** 校验参数再规范化；不合 schema 时抛错（说明回给秘书） */
  normalizeChecked(params: unknown): NormalizedQuickAction;
};

/** 定义一种快速动作（类型推导用：normalize 拿到的参数类型由 params 的 schema 推出） */
export function defineQuickAction<S extends TSchema>(executor: QuickActionExecutor<S>): QuickActionExecutor {
  return executor as unknown as QuickActionExecutor;
}

export class QuickActionRegistry {
  private readonly executors = new Map<string, RegisteredQuickAction>();

  /** 登记一种动作；同一类型登记两次报错（测试替换用 replace）。返回撤销函数（126 号票）：只撤自己登记的那一份 */
  register(executor: QuickActionExecutor, options: { replace?: boolean } = {}): () => void {
    if (this.executors.has(executor.type) && !options.replace) throw new Error(`快速动作 ${executor.type} 已经登记过了`); // @i18n-ignore log：编程错误
    const checker = schemaChecker(executor.params);
    const entry: RegisteredQuickAction = {
      ...executor,
      // 动作的名字跟着当前语言（定义里写成取值函数的，174 号票）：展开会把它取成登记时的值，这里接着现取
      get title() {
        return executor.title;
      },
      normalizeChecked(params) {
        if (!checker.check(params)) throw new Error(checker.firstError(params) ?? "参数不合 schema"); // @i18n-ignore model：交给秘书的出错说明
        return executor.normalize(params);
      },
    };
    this.executors.set(executor.type, entry);
    return () => {
      if (this.executors.get(executor.type) === entry) this.executors.delete(executor.type);
    };
  }

  get(type: string): RegisteredQuickAction | undefined {
    return this.executors.get(type);
  }

  list(): RegisteredQuickAction[] {
    return [...this.executors.values()];
  }
}
