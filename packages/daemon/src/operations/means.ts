// 运营手段登记表（130 号票，ADR-0028）：运营方案里每一条用一种运营手段，每种手段登记——
// - 校验（check）：这一条写得对不对（触发写全了没有、时间在不在将来、事件来源认不认得……），不对的说明交回维护者；
//   几条之间不能撞的（同一个项目两个服务同名、同端口）另登记 checkPlan；要连出去看的（服务的前缀下自检）登记 selfCheck，交的时候异步跑；
//   运行时补齐的（服务的工作目录换成绝对路径、默认值）登记 normalize；
// - 给人看的说法（describe）：触发写成一句话，卡上、项目页上、交给维护者的话里都用它；
// - 生效（apply）：建成这个项目的内部任务（执行者是项目的维护者，64 号票的规矩不变），给出和卡片更新同一事务追加的事件；
//   133 号票的"服务"生效成的不是任务：追加"这个服务该在 LSM 上"的事件，真正的登记、启动在事务之后异步做（project-services/）；
// - 撤销（revoke）：方案里去掉了这一条，取消它的内部任务（服务：撤下）；
// - 就地改（update，可选）：只改了能就地改的部分（比如时间表）时就地改，不然撤了重建；
// - 还跑着没有（alive，可选）：没登记的按它的内部任务算（任务没结束就是跑着）；服务按它在 LSM 上的样子算；
// - 暂停和恢复（pause / resume，可选）：项目停用、重新启用时。定时、事件触发的任务不登记它们：触发底座本来就按项目的状态
//   暂停、恢复这个项目的全部触发登记（scheduled-jobs 的 onProject，19 号票），这里不另做一遍；项目自己的服务（133 号票）登记它们：
//   停用（含使用中归档）时撤出 LSM、撤掉转发，重新启用时重新登记、启动，运营方案模块在项目停用、重新启用时叫。
// "运营模式不限"靠这张表落实：二狗现在能做的全部登记上（定时触发的任务、事件触发的任务，builtin-means.ts；服务，project-services/），
// 以后有新的往表里加，流程不改。二狗现在还做不了的（公网入口，第二阶段）也登记着，automatic 为 false：维护者照样能写进方案，
// 卡上标"这一项二狗现在还做不了，需要你手动：……"，确认时不假装生效。
// 照 ADR-0027：内核的手段由组合根登记，插件经插件宿主登记（ctx.operationMeans.register），每次登记返回撤销函数，停用时撤掉。
// 撤掉之后方案里用它的那一条：交新方案时被拒（没有这种手段），已经生效的照旧在跑（它的内部任务还在），确认时没生效的记原因。
import type { EventNames, EventTrigger, OperationItem, OperationItemDraft, Plan, Project } from "@ergo/protocol";
import type { NewEvent } from "../events/event-store.ts";

/** 校验一条时手段拿得到的 */
export interface OperationCheckContext {
  project: Project;
  /** 现在（协议时间） */
  now: string;
  /** 事件触发方式对不对：事件来源登记表、来源的实现现查（文件夹在不在、能不能监视……）；对的是空数组 */
  checkEventTrigger(trigger: EventTrigger): string[];
  /** 说法里编号换成名字（任务的标题、项目的名字） */
  names: EventNames;
}

/** 一条生效时手段拿得到的 */
export interface OperationApplyContext {
  project: Project;
  /** 同一事务里前面已经建了几个任务（任务编号接着往下排） */
  nth: number;
  /** 流程的那一条：交上来时审查修补后推出的执行用的计划（交上来时存下的） */
  execution?: Plan | undefined;
  /** 流程的那一条：审查要用户逐项确认的事项勾了哪些（流程计划卡上的 key） */
  confirmations: readonly string[];
  /** 用户确认的那次动作的幂等键：随之追加的事件派生自己的键 */
  key: string;
}

/** 一条生效成的东西：它的项目内部任务（服务没有任务：按这一条自己认，见 project-services/） */
export interface OperationBinding {
  taskId?: string | undefined;
}

/** 撤销、就地改、暂停、恢复时手段拿得到的：这一条（生效时的样子）和项目 */
export interface OperationHookContext {
  key: string;
  item: OperationItem;
  project: Project;
}

export interface OperationMeans {
  /** 编号：方案里每一条的 means 写的就是它；定了别改 */
  id: string;
  /** 给人看的名字（"定时触发的任务"） */
  label: string;
  /** 给维护者看的说明（工具说明里列出来）：什么时候用、这一条要写哪几项 */
  hint: string;
  /** 二狗现在能不能替用户做：false 的照样能写进方案，卡上标"需要你手动"，确认时不生效 */
  automatic: boolean;
  /** 这一条写得对不对；对的是空数组 */
  check(item: OperationItemDraft, ctx: OperationCheckContext): string[];
  /** 同一份方案里用这种手段的几条之间撞没撞（同名、同端口……）；对的是空数组 */
  checkPlan?(items: readonly OperationItemDraft[], ctx: OperationCheckContext): string[];
  /** 校验过了，运行时补齐的部分（服务的工作目录换成绝对路径、默认值）：给出补好的这一条 */
  normalize?(item: OperationItem, draft: OperationItemDraft, ctx: OperationCheckContext): OperationItem;
  /** 交的时候要连出去看的（服务的前缀下自检）：problems 整份退回，notes 写进工具结果 */
  selfCheck?(item: OperationItem): Promise<{ problems: string[]; notes: string[] }>;
  /** 触发写成一句话（卡上、项目页上、交给维护者的话里） */
  describe(item: OperationItemDraft, ctx: OperationCheckContext): string;
  /** 生效（automatic 的才有）：建成项目的内部任务（服务没有任务）；做不了的抛错（RequestRejected 的说明记成这一条没生效的原因） */
  apply?(item: OperationItem, ctx: OperationApplyContext): { taskId?: string | undefined; events: NewEvent[] };
  /** 撤销：方案里去掉了这一条（它的内部任务已经结束的什么都不追加；登记了 alive 的不论跑没跑着都叫） */
  revoke?(binding: OperationBinding, ctx: OperationHookContext): NewEvent[];
  /** 就地改：before 换成 after 时能就地改的给出事件，不能的返回 undefined（撤了重建） */
  update?(before: OperationItem, after: OperationItem, binding: OperationBinding, ctx: { key: string }): NewEvent[] | undefined;
  /** 它现在还跑着没有（照旧却没跑着的算"重新开起来"）；不登记的按它的内部任务算 */
  alive?(binding: OperationBinding, ctx: { item: OperationItem; project: Project }): boolean;
  /** 项目停用时（定时、事件触发的由触发底座管，不登记） */
  pause?(binding: OperationBinding, ctx: OperationHookContext): NewEvent[];
  /** 项目重新启用时 */
  resume?(binding: OperationBinding, ctx: OperationHookContext): NewEvent[];
}

/** 运营手段登记表：登记返回撤销函数（只撤自己那一份）；重名的是编程错误。维护者的工具说明每次装配时按它现写 */
export class OperationMeansRegistry {
  private readonly means = new Map<string, OperationMeans>();

  register(means: OperationMeans): () => void {
    if (this.means.has(means.id)) throw new Error(`运营手段 ${means.id} 已经登记过了`); // @i18n-ignore log：编程错误
    this.means.set(means.id, means);
    return () => {
      if (this.means.get(means.id) === means) this.means.delete(means.id);
    };
  }

  get(id: string): OperationMeans | undefined {
    return this.means.get(id);
  }

  /** 登记了的，按登记的先后 */
  list(): OperationMeans[] {
    return [...this.means.values()];
  }
}
