// 记忆的设置（264 号票起）：秘书回话时顺口问"了解你问题"开不开（264，woven-questions.ts）、每条消息有相关记忆时自动带记忆简报开不开
// （266，message-brief.ts）、记忆管理员每周约了解你访谈开不开（284，interview.ts；约访卡上点"不想做了"会关掉），都默认开。
// 照"我的名字"（user-name/user-name.ts）存，**不走事件**：
// - 文件：数据目录配置区的 config/memory-settings.json（dataDirLayout().memorySettingsFile），{ format: 1, wovenQuestions, memoryBrief, interviewInvites }；
//   没有这个文件就是默认（protocol 的 DEFAULT_MEMORY_SETTINGS：都开着）；266 号票以前写的文件没有 memoryBrief、284 号票以前的没有 interviewInvites，按默认；
// - 启动时读入；读不了、内容不对时按默认用（记一行日志，**不覆盖**它），不让守护进程起不来；之后只经设置接口改（手改要重启）；
// - 改（PUT /api/memory/settings）：请求体已经按 schema 查过，改哪项给哪项（266 号票起），没给的照旧；有变化才写。
//   秘书每条输入现取 current()，改了下一条输入就按新的。
// 内核这一侧（组合根建一份，交给网关和记忆插件，KERNEL.memorySettings）：记忆插件停用时设置照样能看能改，只是没人用它。
import fs from "node:fs";
import { DEFAULT_MEMORY_SETTINGS, MemorySettingsFile, type MemorySettingsBody, type MemorySettingsView, schemaChecker } from "@ergo/protocol";
import { writeJsonAtomic } from "../util/json-file.ts";

const settingsFile = schemaChecker(MemorySettingsFile);

export interface MemorySettingsService {
  /** 现在的设置（没有文件、读坏了是默认） */
  current(): MemorySettingsView;
  /** 改哪项给哪项（请求体已经按 schema 查过），没给的照旧；有变化才写文件。回存下的 */
  change(body: MemorySettingsBody): MemorySettingsView;
  /** 读配置文件，之后现取现写 */
  start(): void;
}

export interface MemorySettingsOptions {
  /** config/memory-settings.json（DataDirLayout.memorySettingsFile） */
  file: string;
  log: (line: string) => void;
}

export function createMemorySettings(options: MemorySettingsOptions): MemorySettingsService {
  const { file, log } = options;
  let settings: MemorySettingsView = { ...DEFAULT_MEMORY_SETTINGS };

  /** 配置文件里的设置；没有文件、读坏了、内容不对都是默认（不覆盖文件） */
  const readFile = (): MemorySettingsView => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`记忆的设置文件读不了：${file}：${err instanceof Error ? err.message : String(err)}；先按默认（都开着）`); // @i18n-ignore log
      return { ...DEFAULT_MEMORY_SETTINGS };
    }
    if (settingsFile.check(parsed)) {
      return {
        wovenQuestions: parsed.wovenQuestions,
        memoryBrief: parsed.memoryBrief ?? DEFAULT_MEMORY_SETTINGS.memoryBrief,
        interviewInvites: parsed.interviewInvites ?? DEFAULT_MEMORY_SETTINGS.interviewInvites,
      };
    }
    log(`记忆的设置文件不对：${file}：${settingsFile.firstError(parsed) ?? "格式不对"}；先按默认（都开着，不覆盖它）`); // @i18n-ignore log
    return { ...DEFAULT_MEMORY_SETTINGS };
  };

  return {
    current: () => ({ ...settings }),
    change(body) {
      const next: MemorySettingsView = {
        wovenQuestions: body.wovenQuestions ?? settings.wovenQuestions,
        memoryBrief: body.memoryBrief ?? settings.memoryBrief,
        interviewInvites: body.interviewInvites ?? settings.interviewInvites,
      };
      if (next.wovenQuestions === settings.wovenQuestions && next.memoryBrief === settings.memoryBrief && next.interviewInvites === settings.interviewInvites && fs.existsSync(file)) return { ...settings };
      writeJsonAtomic(file, { format: 1, ...next } satisfies MemorySettingsFile);
      const changed = [
        ...(next.wovenQuestions === settings.wovenQuestions ? [] : [`顺口问${next.wovenQuestions ? "开着" : "关了"}`]), // @i18n-ignore log
        ...(next.memoryBrief === settings.memoryBrief ? [] : [`记忆简报${next.memoryBrief ? "开着" : "关了"}`]), // @i18n-ignore log
        ...(next.interviewInvites === settings.interviewInvites ? [] : [`约访${next.interviewInvites ? "开着" : "关了"}`]), // @i18n-ignore log
      ];
      settings = next;
      log(`记忆的设置改了：${changed.length > 0 ? changed.join("，") : "写下了现在的设置"}`); // @i18n-ignore log
      return { ...settings };
    },
    start() {
      settings = readFile();
    },
  };
}
