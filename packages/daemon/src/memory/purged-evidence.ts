// 彻底删除的素材在推理库里是哪几条证据（265 号票）。问记忆（ask_memory）的结果按证据编号（ev-…）引原话、不带素材 id，
// 彻底删除素材时要按证据编号找到这些结果抹掉：事件日志里那次调用的记录和完整内容（purge.ts）、agent 会话文件里结果的那几行
// （after-purge.ts 的 sessionRewriteFor）。
// - 推理库这边还没删的（刚下命令、记忆插件停用着、推理库那次没删成）：按出处找——证据的 sourceRef 就是素材 id
//   （303 号票：几条数据源素材合成的那条是 digest:<素材 id,…>，materialIdsOfRef 拆开）；忘掉的证据清了原文但还在（墓碑），一样找得到；
// - 已经删掉的（记忆插件跟着记忆命令删了证据，purge-rg.ts）：按彻底删除的审计 rg_purges 找（记着素材 id 和删掉的证据 id；
//   别推断撤掉证据也写这份审计——那之前问记忆引过的照样要抹）。
// 两边合起来、去重、按编号排。会话文件的改写在 agent 闲下来时才做（启动时还会把以前的彻底删除对一遍），那时证据多半已经删了，
// 所以审计这一边不能少；以前漏抹的，守护进程下次启动对一遍时也补上。
// 这一层是内核的（同 graph.ts）：推理库属于数据目录，记忆插件停用了照样查。只读、随用随开、用完就关；库没建、版本对不上、
// 打不开、读出错 → 空（这时也没有问记忆引得出的原话，或者查不了），记一行日志，不让彻底删除失败。
import fs from "node:fs";
import { DEEPSEEK_DEFAULT_MODEL, purgeRecords } from "@ergo/memory";
import { nowIso } from "@ergo/protocol";
import { materialIdsOfRef } from "./data-source-evidence.ts";
import { openReasoningDb } from "./rg-db.ts";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 这些素材在推理库里对应的证据编号（还在的按出处、删掉的按审计）；查不了是空的 */
export function purgedEvidenceIds(file: string, materialIds: readonly string[], log: (line: string) => void = () => {}): string[] {
  return lookupPurgedEvidence(file, materialIds, log) ?? [];
}

/**
 * 同 purgedEvidenceIds，但分得清"查了、没有"和"查不了"（272 号票的一次性补抹：查不了的时候不记"做完了"，下次启动再补）：
 * 库没建（空文件）是查了、没有（那时问记忆也引不出原话）；打不开、版本对不上、读出错是 undefined
 */
export function lookupPurgedEvidence(file: string, materialIds: readonly string[], log: (line: string) => void = () => {}): string[] | undefined {
  const wanted = new Set(materialIds);
  if (wanted.size === 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) return [];
  let opened;
  try {
    opened = openReasoningDb({ file, clock: nowIso, model: DEEPSEEK_DEFAULT_MODEL, readOnly: true });
  } catch (err) {
    log(`彻底删除：查被删素材在推理库里的证据时打不开推理库：${messageOf(err)}`);
    return undefined;
  }
  if (!opened.ok) {
    log(`彻底删除：查被删素材在推理库里的证据时推理库用不了（${opened.issue.code}）`);
    return undefined;
  }
  const engine = opened.engine;
  try {
    const ids = new Set<string>();
    for (const evidence of engine.store.listEvidence()) if (materialIdsOfRef(evidence.sourceRef).some((id) => wanted.has(id))) ids.add(evidence.id);
    for (const record of purgeRecords(engine)) {
      if (record.materialIds.some((id) => wanted.has(id))) for (const id of record.evidenceIds) ids.add(id);
    }
    return [...ids].toSorted();
  } catch (err) {
    log(`彻底删除：查被删素材在推理库里的证据时出错：${messageOf(err)}`);
    return undefined;
  } finally {
    engine.close();
  }
}
