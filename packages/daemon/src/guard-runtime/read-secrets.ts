// 读过的密钥值（规格第 9 节，30 号票）：agent 读过 .env 或密钥文件之后，模型就知道里面的明文了。没有前缀的随机串写进网址、
// 参数、请求头里，密钥形态的正则认不出，所以守护进程在这次调用执行成功之后，把那个文件里的值（guard/secret-files.ts 的
// secretValuesIn）收进这个任务（不属于任务的是这一段会话）的"读过的密钥值"，之后判定时作为环境事实 secretValues 交给守卫，
// 出现在联网调用的对外内容里就是"把凭据写进对外内容"（永不）。
// 只放内存：不落盘、不进事件日志、不写进任何说明；守护进程重启后就没了（"读过之后不许往外送"的规则照旧管着）。
// 范围和效果日志一样：任务里看同一个任务的，不属于任务的看同一个 agent、同一段会话的。
import fs from "node:fs";
import { comparable, isSecretFile, isWindowsAbsolutePath, normalizeArgs, secretValuesIn, type GuardInput, type GuardJudgement } from "../guard/index.ts";
import type { EffectScope } from "./effect-log.ts";

/** 太大的文件不读（密钥文件都很小）；一个范围里最多记多少个值 */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_VALUES_PER_SCOPE = 500;

export interface ReadSecrets {
  /** 一次放行、执行成功的调用之后（调用方保证）：它读过的密钥文件里的值，收进这次调用的范围 */
  capture(input: GuardInput, judgement: GuardJudgement): void;
  /** 这个范围里读过的值 */
  valuesFor(scope: EffectScope): string[];
}

export function createReadSecrets(): ReadSecrets {
  const byScope = new Map<string, string[]>();
  return {
    capture(input, judgement) {
      const files = secretFilesRead(input, judgement);
      if (files.length === 0) return;
      const key = scopeKey(scopeOf(input));
      const values = byScope.get(key) ?? [];
      for (const { file, named } of files) {
        for (const value of secretValuesIn(named, readSmallFile(file))) {
          if (!values.includes(value) && values.length < MAX_VALUES_PER_SCOPE) values.push(value);
        }
      }
      if (values.length > 0) byScope.set(key, values);
    },
    valuesFor(scope) {
      return [...(byScope.get(scopeKey(scope)) ?? [])];
    },
  };
}

/** 一次判定的范围（和效果日志一样） */
export function scopeOf(input: Pick<GuardInput, "task" | "agent" | "segmentId">): EffectScope {
  return input.task ? { taskId: input.task.taskId } : { taskId: null, agentId: input.agent.agentId, segmentId: input.segmentId };
}

function scopeKey(scope: EffectScope): string {
  return scope.taskId !== null ? `task\u0000${scope.taskId}` : `segment\u0000${scope.agentId}\u0000${scope.segmentId ?? ""}`;
}

/**
 * 这次判定的调用里读到的密钥文件（路径参数是读或不知道读写；路径或真实路径的文件名像密钥文件）。
 * named 是认出它是密钥文件的那个名字（符号链接指向 .env 时按真实路径的名字拆值）
 */
function secretFilesRead(input: GuardInput, judgement: GuardJudgement): { file: string; named: string }[] {
  const env = { cwd: input.agent.cwd, homeDir: input.places.homeDir };
  const out = new Map<string, { file: string; named: string }>();
  for (const call of judgement.calls) {
    const descriptor = input.tools[call.tool];
    if (!descriptor) continue;
    const args = normalizeArgs(call.tool, call.args, input.tools, env);
    for (const [name, rule] of Object.entries(descriptor.args)) {
      if (rule.kind !== "path" || rule.access === "write" || rule.access === "delete") continue;
      const value = args[name];
      for (const p of Array.isArray(value) ? value : [value]) {
        if (typeof p !== "string" || !isWindowsAbsolutePath(p) || out.has(comparable(p))) continue;
        const real = Object.entries(input.facts.files ?? {}).find(([key]) => comparable(key) === comparable(p))?.[1].realPath;
        if (isSecretFile(p)) out.set(comparable(p), { file: p, named: p });
        else if (real !== undefined && isSecretFile(real)) out.set(comparable(p), { file: p, named: real });
      }
    }
  }
  return [...out.values()];
}

/** 读一个小文件的文字；读不了、是目录或太大时为空 */
function readSmallFile(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
