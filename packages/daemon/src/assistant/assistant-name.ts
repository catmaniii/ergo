// 个人助理的名字（43 号票，规格第 19 节"名称"）：用户给秘书起的名字，界面上处处用它，秘书的系统提示里也有。
//
// 照工作日历的个人设置（workday/calendar.ts）存和推，不另起一套：
// - 名字存在数据目录配置区的 assistant-name.json（随数据目录备份，不进仓库），是真相；只由运行时写（设置接口）；
//   配置区是受保护区域，agent 用任何方式都写不进（03 号票）。
// - 每次改名是名字频道上的一条 assistant_name 事件（名字的最新样子），开着的前端据此跟着变；先写文件、再追加事件。
// - 启动时读入配置文件：和上一条事件不一样（停着时手改过、从备份恢复了配置区、上次写完文件没来得及追加）就以文件为准，
//   补一条来源为 config_file 的事件。文件读不了、名字不合规时不覆盖它，记日志，沿用事件日志里上一次的名字。
// - 名字变了，onChange 登记的函数被叫（秘书据此在下一轮之前按新名字重新装配）。
import fs from "node:fs";
import {
  type AssistantNameEventPayload,
  AssistantNameFile,
  type AssistantNameSource,
  CHANNELS,
  checkAssistantName,
  DEFAULT_ASSISTANT_NAME,
  EVENT_TYPES,
  schemaChecker,
} from "@ergo/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import { writeJsonAtomic } from "../util/json-file.ts";

const nameFile = schemaChecker(AssistantNameFile);

export interface AssistantNameService {
  /** 现在的名字（没起过名是默认的"二狗"，89 号票起；原来是"个人助理"） */
  current(): string;
  /** 改名：按起名的规则查（不合规抛 RequestRejected），写配置文件，有变化时追加事件 */
  change(raw: string, source: AssistantNameSource): { name: string; changed: boolean };
  /** 名字变了时叫 fn；返回取消登记的函数 */
  onChange(fn: (name: string) => void): () => void;
  /** 读配置文件，和事件日志对一遍（不一样就补一条事件），之后跟着事件走 */
  start(): void;
  stop(): void;
}

export interface AssistantNameServiceOptions {
  store: EventStore;
  layout: DataDirLayout;
  log: (line: string) => void;
}

export function createAssistantNameService(options: AssistantNameServiceOptions): AssistantNameService {
  const { store, layout, log } = options;
  const file = layout.assistantNameFile;
  let name = DEFAULT_ASSISTANT_NAME;
  const listeners = new Set<(name: string) => void>();
  let unsubscribe: (() => void) | undefined;

  const append = (payload: AssistantNameEventPayload) => store.append({ channel: CHANNELS.assistantName, type: EVENT_TYPES.assistantName, payload });

  /** 配置文件里的名字；没有文件是 undefined；文件不对时 null（记日志，不覆盖它） */
  const readFile = (): string | undefined | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      log(`个人助理的名字的配置文件读不了：${file}：${err instanceof Error ? err.message : String(err)}；先按事件日志里上一次的名字用`);
      return null;
    }
    const checked = nameFile.check(parsed) ? checkAssistantName(parsed.name) : { ok: false as const, error: nameFile.firstError(parsed) ?? "格式不对" }; // @i18n-ignore log：只进日志
    if (checked.ok) return checked.name;
    log(`个人助理的名字的配置文件不对：${file}：${checked.error}；先按事件日志里上一次的名字用`);
    return null;
  };

  return {
    current: () => name,
    change(raw, source) {
      const checked = checkAssistantName(raw);
      if (!checked.ok) throw new RequestRejected("bad_params", checked.error);
      if (checked.name === name) return { name, changed: false };
      writeJsonAtomic(file, { format: 1, name: checked.name } satisfies AssistantNameFile);
      append({ name: checked.name, source });
      return { name: checked.name, changed: true };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      unsubscribe = store.onAppend((event) => {
        if (event.channel !== CHANNELS.assistantName || event.type !== EVENT_TYPES.assistantName) return;
        const next = (event.payload as AssistantNameEventPayload).name;
        if (next === name) return;
        name = next;
        for (const fn of listeners) fn(name);
      });
      name = (store.read(CHANNELS.assistantName, 0, EVENT_TYPES.assistantName).at(-1)?.payload as AssistantNameEventPayload | undefined)?.name ?? DEFAULT_ASSISTANT_NAME;
      // 配置文件是真相：和上一条事件（没有事件就是默认的名字）不一样就补一条
      const fromFile = readFile();
      if (typeof fromFile === "string" && fromFile !== name) append({ name: fromFile, source: "config_file" });
    },
    stop() {
      unsubscribe?.();
      listeners.clear();
    },
  };
}
