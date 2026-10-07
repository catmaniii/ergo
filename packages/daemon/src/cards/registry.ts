// 卡片类型注册表（规格第 5 节）：每种卡登记类型、负载的 schema 和版本、纯文本降级版本，以及它接受哪些动作。
// - 建卡和动作改出来的负载都按 schema 校验；
// - 纯文本降级版本由 toText 按负载生成，存在卡片实体的 text 里：不认识这种卡（或这个版本）的前端显示它；
// - 动作：每个动作可以带一个结构化输入的 schema，run 决定动作之后卡片的状态和负载，
//   并可以给出随卡片更新一起（同一事务）追加的事件（比如提醒被改了）。
// 本票登记简单提醒卡（reminders/card.ts），其他卡由各自的票登记（daemon.ts 里组装注册表）。
import { CARD_TYPE_VERSIONS, type Card, type CardAction, type CardStatus, type CardType, schemaChecker, type Static, type TSchema } from "@ergou/protocol";
import type { NewEvent } from "../events/event-store.ts";

/** 动作执行时拿到的东西 */
export interface CardActionContext<P> {
  /** 动作之前的卡片 */
  card: Card;
  /** 动作之前的负载（按 schema 校验过） */
  payload: P;
  action: CardAction;
  /** 用户附带的说明 */
  note?: string;
  /** 按这个动作的 input schema 校验过的输入（动作没有 input schema 时是 undefined） */
  input: unknown;
  /** 现在（协议时间） */
  now: string;
  /** 前端请求的幂等键：随卡片一起追加的事件要幂等，就用它派生自己的键 */
  idempotencyKey: string;
}

/** 动作的结果 */
export interface CardActionEffect<P> {
  /**
   * 动作之后卡片的状态：已处理、已关闭（用户关掉不处理，产生"卡片被关闭"事件），
   * 或者仍待处理（比如改了提醒，卡片还能再改、再取消）
   */
  status: CardStatus;
  /** 新的负载；不给就不变 */
  payload?: P;
  /** 处理结果的说明（写进卡片的 outcome.note） */
  note?: string;
  /** 随卡片更新一起追加的事件（同一事务，排在卡片更新之前） */
  events?: NewEvent[];
}

export interface CardActionSpec<P> {
  /** 动作附带的结构化输入的 schema；不给就不收输入 */
  input?: TSchema;
  /** 执行动作；不让做时抛 RequestRejected（比如提醒已经响过了，不能再改） */
  run(ctx: CardActionContext<P>): CardActionEffect<P>;
}

export interface CardTypeDefinition<S extends TSchema = TSchema> {
  type: CardType;
  /** 负载的版本：必须和共享协议包 CARD_TYPE_VERSIONS 里登记的一致（前端靠它判断认不认识） */
  version: number;
  /** 负载的 schema（TypeBox，放在共享协议包里，守护进程和 Web 共用类型） */
  payload: S;
  /** 这种卡接受的动作；不在这里的动作一律拒绝 */
  actions: Partial<Record<CardAction, CardActionSpec<Static<S>>>>;
  /** 纯文本降级版本：不认识这种卡的前端（以及以后的 Telegram 之类）显示它 */
  toText(payload: Static<S>): string;
}

/** 登记好的一种卡：带编译好的校验器 */
export interface RegisteredCardType {
  readonly definition: CardTypeDefinition;
  /** 负载合不合 schema；不合时给出第一条错误 */
  checkPayload(payload: unknown): string | undefined;
  /** 某个动作的输入合不合它的 schema；不合时给出第一条错误 */
  checkInput(action: CardAction, input: unknown): string | undefined;
}

/** 定义一种卡（类型推导用：负载的类型由 schema 推出） */
export function defineCardType<S extends TSchema>(definition: CardTypeDefinition<S>): CardTypeDefinition<S> {
  return definition;
}

export class CardTypeRegistry {
  private readonly types = new Map<string, RegisteredCardType>();

  /** 登记一种卡；同一类型登记两次报错（测试替换登记用 replace） */
  register(definition: CardTypeDefinition, options: { replace?: boolean } = {}): void {
    if (this.types.has(definition.type) && !options.replace) throw new Error(`卡片类型 ${definition.type} 已经登记过了`);
    const expected = CARD_TYPE_VERSIONS[definition.type];
    if (definition.version !== expected) {
      throw new Error(`卡片类型 ${definition.type} 登记的版本 ${definition.version} 和共享协议包 CARD_TYPE_VERSIONS 里的 ${expected} 不一致：改了负载的形状要两边一起改`);
    }
    const payload = schemaChecker(definition.payload);
    const inputs = new Map(
      Object.entries(definition.actions).flatMap(([action, spec]) => (spec?.input ? [[action, schemaChecker(spec.input)] as const] : [])),
    );
    this.types.set(definition.type, {
      definition,
      checkPayload: (value) => payload.firstError(value),
      checkInput: (action, value) => inputs.get(action)?.firstError(value),
    });
  }

  get(type: string): RegisteredCardType | undefined {
    return this.types.get(type);
  }

  /** 登记了的类型 */
  list(): string[] {
    return [...this.types.keys()];
  }
}
