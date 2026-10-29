// 实体对齐（199 号票）：别名、"老王 / 王哥"。
// - 抽取器交出"这两个叫法是同一个人"（AliasDraft，带出处的那段原文）；引擎抽这条证据的事实之前先对齐，这条证据里的两个叫法就落到同一个实体；
// - 两个叫法都还没有实体：建一个，另一个记成别名；只有一个有：给它加别名；
// - 两个都已经是实体（先在别的证据里各自出现过）：合并。留先建的那个（同名查找按先建的取，合并以后两个名字都找到它），
//   指向后建的那个的事实改成指向留下的，后建的那个的名字和别名并进留下的；每条改动照常写修订，起因是说出别名的那条证据。
// 合并不拆：证据被忘掉以后不把两个实体再分开（见 199 号票 Comments）。
import type { EntityType, Evidence, FactStatus } from "../domain/types.ts";
import { type MemoryStore, rgWriter } from "../store/store.ts";
import type { KgView } from "./extractor.ts";
import type { KnowledgeGraph } from "./graph.ts";

/** 抽取器交出的一对叫法：name 和 alias 是同一个实体 */
export interface AliasDraft {
  name: string;
  alias: string;
  type: EntityType;
  /** 说出这一对的那段原文 */
  span: string;
}

/** 会交出别名的抽取器（规则版 RelationalFactExtractor、模型版 LlmFactExtractor） */
export interface AliasAware {
  aliasesOf(evidence: Evidence, known: KgView): AliasDraft[];
}

export function isAliasAware(x: unknown): x is AliasAware {
  return typeof (x as Partial<AliasAware>).aliasesOf === "function";
}

export interface AlignReport {
  /** 新建的实体、加了别名的实体、合并掉的实体（被并进别的） */
  created: string[];
  aliased: string[];
  merged: { keep: string; dropped: string; factIds: string[] }[];
}

const ALL_STATUSES: readonly FactStatus[] = ["active", "contested", "superseded", "corrected", "retracted"];

/** 两个实体谁先建（rowid 小的在前）：留先建的 */
function earlier(store: MemoryStore, a: string, b: string): [string, string] {
  const order = store.listEntities().map((e) => e.id);
  return order.indexOf(a) <= order.indexOf(b) ? [a, b] : [b, a];
}

/**
 * 把 dropId 并进 keepId：指向 dropId 的事实（主语、宾语）改成 keepId，dropId 的名字和别名记成 keepId 的别名。
 * 返回改了的事实。在调用方的事务里做
 */
export function mergeEntities(store: MemoryStore, keepId: string, dropId: string, cause: { evidenceId: string | null; reason: string }): string[] {
  if (keepId === dropId) return [];
  const keep = store.getEntity(keepId);
  const drop = store.getEntity(dropId);
  if (!keep || !drop) throw new Error(`没有这个实体：${keep ? dropId : keepId}`);
  const changed: string[] = [];
  for (const f of store.factsTouching(dropId, ALL_STATUSES)) {
    const patch: { subjectId?: string; object?: { type: "entity"; id: string } } = {};
    if (f.subjectId === dropId) patch.subjectId = keepId;
    if (f.object.type === "entity" && f.object.id === dropId) patch.object = { type: "entity", id: keepId };
    if (Object.keys(patch).length === 0) continue;
    rgWriter(store).updateFact(f.id, patch, { ...cause, reason: `${cause.reason}：${drop.name} 并进 ${keep.name}` });
    changed.push(f.id);
  }
  for (const name of [drop.name, ...drop.aliases]) store.addAlias(keepId, name, { ...cause, reason: `${cause.reason}：${name} 是 ${keep.name} 的别名` });
  return changed;
}

/** 按一条证据交出的别名对齐实体（引擎抽这条证据的事实之前调） */
export function alignAliases(kg: KnowledgeGraph, drafts: readonly AliasDraft[], evidence: Evidence): AlignReport {
  const store = kg.store;
  const report: AlignReport = { created: [], aliased: [], merged: [] };
  for (const d of drafts) {
    const name = d.name.trim();
    const alias = d.alias.trim();
    if (name.length === 0 || alias.length === 0 || name === alias) continue;
    const reason = `实体对齐（${d.span}）`;
    const cause = { evidenceId: evidence.id, reason };
    const a = store.findEntityByName(name);
    const b = store.findEntityByName(alias);
    if (!a && !b) {
      const e = store.insertEntity({ type: d.type, name, aliases: [alias] }, { ...cause, reason: `${reason}：新实体，别名 ${alias}` });
      report.created.push(e.id);
    } else if (a && !b) {
      store.addAlias(a.id, alias, { ...cause, reason: `${reason}：${alias} 是 ${a.name} 的别名` });
      report.aliased.push(a.id);
    } else if (!a && b) {
      store.addAlias(b.id, name, { ...cause, reason: `${reason}：${name} 是 ${b.name} 的别名` });
      report.aliased.push(b.id);
    } else if (a && b && a.id !== b.id) {
      const [keep, dropped] = earlier(store, a.id, b.id);
      const factIds = mergeEntities(store, keep, dropped, cause);
      report.merged.push({ keep, dropped, factIds });
    }
  }
  return report;
}
