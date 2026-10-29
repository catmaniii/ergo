// 旧配置（241 号票）：config/agent-profiles.json 的只读版本，只在 248 号票第一次迁移到角色表时读一次。
// 形状：{ format: 1, agents: { "<agent id>": { name?, voiceId? } } }。读不出来的项当成没配（和 241 一样），记日志；
// 迁移之后这个文件保留不删（回滚用），守护进程不再读它（除了这里）。
import fs from "node:fs";
import { AGENT_PROFILE_FORMAT, checkAssistantName } from "@ergo/protocol";

/** 一个 agent 以前自己配的那两项（校验过的） */
export interface LegacyProfile {
  name?: string;
  voiceId?: string;
}

/** 只认对象，别的当成没有 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** 读旧文件：没有这个文件、读不了、形状不对都是空的（记日志）；名字不合规的那一项当成没配 */
export function readLegacyAgentProfiles(file: string, log: (line: string) => void): Record<string, LegacyProfile> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`旧的名字音色配置读不了（迁移时跳过它）：${file}：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：只进日志
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    log(`旧的名字音色配置不是 JSON（迁移时跳过它，文件留着）：${file}：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：只进日志
    return {};
  }
  const document = obj(parsed);
  if (document === undefined || document.format !== AGENT_PROFILE_FORMAT) {
    log(`旧的名字音色配置形状不对（迁移时跳过它，文件留着）：${file}`); // @i18n-ignore log：只进日志
    return {};
  }
  const agents = obj(document.agents);
  if (agents === undefined) return {};
  const out: Record<string, LegacyProfile> = {};
  for (const [agentId, value] of Object.entries(agents)) {
    const entry = obj(value);
    if (entry === undefined) {
      log(`旧配置里 agent ${agentId} 的那一项不是对象，迁移时跳过`); // @i18n-ignore log：只进日志
      continue;
    }
    const checked = typeof entry.name === "string" ? checkAssistantName(entry.name) : undefined;
    if (checked !== undefined && !checked.ok) log(`旧配置里 agent ${agentId} 的名字不合规，迁移时当成没配：${checked.error}`); // @i18n-ignore log：只进日志
    const name = checked?.ok === true ? checked.name : undefined;
    const voiceId = typeof entry.voiceId === "string" && entry.voiceId !== "" ? entry.voiceId : undefined;
    if (name === undefined && voiceId === undefined) continue;
    out[agentId] = { ...(name === undefined ? {} : { name }), ...(voiceId === undefined ? {} : { voiceId }) };
  }
  return out;
}
