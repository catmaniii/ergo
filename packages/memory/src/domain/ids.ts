// id：带前缀的字符串（第 4 节）。存储分配的是 <前缀>-NNNN（按种类各自计数，同样的写入顺序得到同样的 id，结果可复现）；
// 合成数据的证据沿用事件 id（ev-001）。用户本人这个实体固定是 en-user。

export const ID_PREFIX = {
  evidence: "ev",
  entity: "en",
  fact: "fa",
  claim: "cl",
  inference: "in",
  probe: "pr",
  /** 交互策略（196 号票） */
  strategy: "st",
  /** 预测账本（226 号票） */
  prediction: "pd",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** 用户本人 */
export const USER_ENTITY_ID = "en-user";

const KIND_BY_PREFIX = new Map<string, IdKind>(Object.entries(ID_PREFIX).map(([kind, prefix]) => [prefix, kind as IdKind]));

/** 按前缀认出是哪种对象的 id；认不出是 undefined */
export function idKind(id: string): IdKind | undefined {
  const m = /^([a-z]{2})-[A-Za-z0-9_.:-]+$/.exec(id);
  return m ? KIND_BY_PREFIX.get(m[1]!) : undefined;
}

export function isIdOf(kind: IdKind, id: unknown): id is string {
  return typeof id === "string" && idKind(id) === kind;
}

/** 第 n 个：fa-0001 */
export function formatId(kind: IdKind, n: number): string {
  return `${ID_PREFIX[kind]}-${String(n).padStart(4, "0")}`;
}
