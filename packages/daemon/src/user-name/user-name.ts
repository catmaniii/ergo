// 我的名字（249 号票）：用户**自己**的名字。和"个人助理的名字"（assistant/assistant-name.ts，43 号票）是两回事——
// 那个是用户给秘书起的、界面上处处用它；这个是用户自己的，各 agent 的系统提示里知道该称呼用户什么（prompts/library.ts 的
// 前缀那句），界面上能用则用（秘书页的副标题、待办的副标题、设置 · 身份那一项）。
//
// 照个人助理的名字存（配置区里的 JSON 是真相，只由运行时写，agent 写不了），但**不走事件**：
// - 文件：数据目录配置区的 config/user-name.json（dataDirLayout().userNameFile），{ format: 1, name }；
//   没有这个文件就是没设（行为同现在，提示、界面一个字节都不变）；
// - 启动时读入；读不了、内容不对、名字不合规时只当没设（记一行日志，**不覆盖**它），不让守护进程起不来；
// - 改名字（PUT /api/user-name）：按 checkUserName 查（不合规抛 RequestRejected，HTTP 回 400 带原因）；
//   null 或者空串（含只有空白的）是清除，删掉文件；有变化才写；
// - 名字变了，onChange 登记的函数被叫（秘书、记忆管理员据此手头这一条处理完就按新的系统提示重新装配；维护者在下一条输入
//   之前按新的重新拉起）：不走事件是因为界面上用到它的地方打开页面时经 GET 现取一次就够，不必为一句话多一个频道。
import fs from "node:fs";
import { checkUserName, schemaChecker, UserNameFile, type UserNameResult, type UserNameView } from "@ergo/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import { writeJsonAtomic } from "../util/json-file.ts";

const userNameFile = schemaChecker(UserNameFile);

export interface UserNameService {
  /** 现在的名字；没设（文件不在、只当没设）是 undefined */
  current(): string | undefined;
  /** 现在的样子（GET /api/user-name）：没设时没有 name */
  view(): UserNameView;
  /** 改名字（null 或者空串 = 清除）：按起名的规则查，不合规抛 RequestRejected；写配置文件，有变化才叫 onChange */
  change(raw: string | null): UserNameResult;
  /** 名字变了时叫 fn（改成没设也是 undefined）；返回取消登记的函数 */
  onChange(fn: (name: string | undefined) => void): () => void;
  /** 读配置文件，之后现取现写 */
  start(): void;
  stop(): void;
}

export interface UserNameServiceOptions {
  layout: DataDirLayout;
  log: (line: string) => void;
}

export function createUserNameService(options: UserNameServiceOptions): UserNameService {
  const { layout, log } = options;
  const file = layout.userNameFile;
  let name: string | undefined;
  const listeners = new Set<(name: string | undefined) => void>();

  /** 配置文件里的名字；没有文件、读坏了、内容不对都是 undefined（只当没设，不覆盖文件） */
  const readFile = (): string | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`我的名字的配置文件读不了：${file}：${err instanceof Error ? err.message : String(err)}；先当没设`);
      }
      return undefined;
    }
    const checked = userNameFile.check(parsed) ? checkUserName(parsed.name) : { ok: false as const, error: userNameFile.firstError(parsed) ?? "格式不对" }; // @i18n-ignore log：只进日志
    if (checked.ok) return checked.name;
    log(`我的名字的配置文件不对：${file}：${checked.error}；先当没设（不覆盖它）`);
    return undefined;
  };

  /** 名字变了（包括清除）：叫登记过的 */
  const fire = () => {
    for (const fn of listeners) fn(name);
  };

  return {
    current: () => name,
    view: () => (name === undefined ? {} : { name }),
    change(raw) {
      // null、空串、只有空白：清除
      if (raw === null || raw.trim() === "") {
        if (name === undefined && !fs.existsSync(file)) return { changed: false };
        fs.rmSync(file, { force: true });
        const changed = name !== undefined;
        name = undefined;
        if (changed) fire();
        return { changed };
      }
      const checked = checkUserName(raw);
      if (!checked.ok) throw new RequestRejected("bad_params", checked.error);
      if (checked.name === name) return { name, changed: false };
      writeJsonAtomic(file, { format: 1, name: checked.name } satisfies UserNameFile);
      name = checked.name;
      fire();
      return { name, changed: true };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      name = readFile();
    },
    stop() {
      listeners.clear();
    },
  };
}
