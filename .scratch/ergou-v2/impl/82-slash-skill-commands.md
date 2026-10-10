# 82 — 斜杠命令直接写 skill 名，输入框打 / 弹候选

Status: done
Blocked by: None — can start immediately
Spec: 72 号票（`/skill:名字` 展开）；ADR 0019（`/流程`、`/任务`）

## What to build

用户 2026-10-10 定：skill 不用 `/skill:` 前缀，**直接 `/名字`**，像 Claude Code 一样；输入框里打 `/` 弹出候选列表。

- **展开规则**：
  - `/名字` 直接展开这个 skill（72 号票的展开逻辑，在加时间标记之前展开），比如 `/mp-tdd`、`/Poteto Mode 帮我看看这个设计`。
  - 和二狗自己的斜杠命令（`/流程`、`/任务`，以及以后加的）同名时，**二狗的命令优先**；这时用 `/skill:名字` 点那个 skill。`/skill:名字` 照旧能用。
  - **命令名严格等于 skill 的目录名**（用户 2026-10-10 定：命令不支持带空格）：`/` 后面到第一个空白就是命令名，不做最长匹配。比如 `/mp-tdd`、`/poteto-mode`（显示名 Poteto Mode）、`/agent-browser`。
  - **目录名一律是不带空格的小写**：导入时规范化（转小写，空格等不合适的字符换成 `-`）；SKILL.md 一字不动，显示名仍是原来的。不同集合里目录名相同的用 `集合名:目录名` 区分。
  - 只认这个会话能用的 skill（秘书的、这个任务或项目工具包里的）；不认识的 `/xxx` 原样当正文发出去，不报错。
- **候选列表**（Web 输入栏，三处会话都有）：
  - 在输入框开头打 `/` 弹出，列出二狗的命令和这个会话能用的 skill（集合里的显示集合名作小标），边打边过滤；
  - 方向键或点按选中，插入 `/名字 `，接着打正文；
  - 列表浮在最上层（照语音菜单那次修的 `PopupMenu`），不被输入栏、标题栏挡住；
  - 语音模式下不弹（语音里说名字照旧算点名）。
- 守护进程给前端一个"这个会话能用的斜杠命令"的列表（命令名、类型：命令 / skill、一句说明、所属集合）。

## Acceptance criteria

- [ ] `/mp-tdd 正文`、`/poteto-mode 正文` 都展开对应 skill，`/Poteto Mode` 这种带空格的不认；`/流程` 仍是发起流程；同名时命令优先、`/skill:名字` 点 skill；不认识的原样发；主切面测试。
- [ ] 候选列表能弹出、过滤、选中插入；浮在最上层；截图（390、1280）写进 Comments。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Comments

- 2026-10-10 实现（worktree 分支 `worktree-agent-a4e6833136e25be2d`，从 main `a6e30615` 开始，收尾变基到 `d6a3ab03`（含 71 号票））。照主会话转来的两条改动做：写法严格等于目录名、不做最长匹配、目录名一律小写不带空格。说明在 `docs/dev.md` 的"skill 库、MCP 登记与工具包"一节（新加"斜杠命令直接写 skill 的目录名"），`CONTEXT.md` 加了"斜杠命令"。没有读、没有改 `~/.ergou`，测试都是自己造的假 skill。
  - **展开**（`skills/skill-command.ts` 的 `expandSkillCommand`，`conversation/agent-input.ts` 在加时间标记之前做）：`/` 后面到第一个空白就是写法；`/skill:写法` 是后备。写法按整个库算（`skillCommands`）：就是目录名；几个 skill 目录名相同时集合里的写 `集合名:目录名`（`/pstack:tdd`）。打的字被认成这个会话里有的二狗自己的命令（`slash-commands/commands.ts` 的 `commandAt`，和发起任务的"点明"判定同一个规则）时不展开。只认这个会话装配了的 skill（`AgentSession` 拉起时的 `skillPaths` 从库的写法表里挑；秘书、任务、项目、作业的维护者都接上）。`/Poteto Mode`、`/skill:Poteto Mode` 这种带空格的不认了（72 号票的测试跟着改成 `/skill:fancy-mode`）。
  - **二狗自己的命令表**：`slash-commands/commands.ts` 的 `ERGOU_COMMANDS`（`/流程`、`/任务`，`LAUNCH_COMMANDS` 挪到这里，`tasks/launch-intent.ts` 照旧导出），以后加的命令登记在这里。
  - **目录名规范化**（`skills/library.ts` 的 `normalizeSkillDirName`）：导入时转小写，空格和别的不合适的字符换成 `-`，连续的 `-` 合成一个；单个 skill 和集合成员都是。规范之后重名的拒绝并说清和谁（"目录名 FANCY skill v2（规范之后是 fancy-skill-v2） 和你导入的 Fancy Skill 的目录重名"）。已有的不合规目录名启动时记一条日志、skill 库页最上面提示（`ToolkitCatalog.skillDirProblems`），不自动改。
  - **候选列表**：`GET /api/conversations/<会话>/slash-commands`（`SlashCommandList`：`kind`、`text` 插进输入框的写法、`name` 显示的名字、`description`、`collection`）。秘书、项目的会话先列 `/流程`、`/任务`，再列能用的 skill（和装配时一样现取：秘书的名单、项目维护者此刻这一段的工具包、任务维护者现在生效的计划；起草计划时没有）。Web：`Composer.tsx` 在开头打 `/`、还没打空白时现取、弹出 `SlashMenu.tsx`（画在 `PopupMenu` 里，浮在最上层）；一行是"写法  显示的名字 · 一句说明"，集合名作小标，命令标"命令"；边打边过滤（`state/slash-commands.ts`），方向键、Enter / Tab（输入法组字时不算）、点按选中，插入"写法 + 空格"；Esc、点别处关掉；语音模式下不弹。`PopupMenu` 改了两处：菜单自己大小变了跟着重新放（ResizeObserver），菜单里面的滚动、滚轮不关它。
  - **截图**（原型假数据，构建产物直接打开，Edge 无头）：会话 scratchpad 的 `t82/slash-390.png`、`slash-1280.png`（打 `/` 全列）、`slash-390-filter.png`、`slash-1280-filter.png`（打 `/demo`、方向键挪一行）。脚本核对过：菜单在输入框上面、`elementFromPoint` 取到的是菜单（没被挡），Enter 后输入框是 `/demo-implement `、菜单关了。
  - **拿不准、按下面理解做了的地方**（主会话 2026-10-10 回复：前三条照下面"定了"改；别的没提，照原样）：
    - **集合成员的目录名不合规**也规范化（只改目录名）。**定了**：照改名，不拒绝；报告里这一项写"目录名从 X 改成了 Y，集合里其他 skill 按原目录名写的相对引用可能对不上"。真实的 pstack、matt-pocock 成员目录都已经合规，现在碰不到。
    - **单个 skill 的目录名和框架自带的 skill 的目录名相同**：拒绝导入（不然 `/目录名` 分不清）。**定了**：可以。两个不在集合里的同目录名只有手放进 skill 区才会有：先扫到的（框架自带的在前）留着 `/目录名`，另一个没有写法，skill 库页上提示。
    - ~~命令优先不分会话~~。**定了**：命令优先只在命令存在的会话里成立。`/流程`、`/任务` 只在秘书和项目的会话里有；任务的会话里同名的 skill 直接 `/流程` 就展开，候选里也写 `/流程`（`AgentSessionOptions.slashConversation` → `ergouCommandsIn`，展开和候选列表用同一个判断；单元测试和主切面的任务会话各补了一条）。
    - `/流程-助手` 这种"命令后面跟标点"的，发起任务的判定本来就认成 `/流程`，skill 跟着让路（要写 `/skill:流程-助手`）。
    - `集合名:目录名` 只在目录名撞上时用，写法按整个库算（同一个 skill 在哪个会话里写法都一样，但以后导入一个同目录名的 skill 时集合里的那个会变成带集合名的）。集合名不能叫 `skill`（会和 `/skill:` 分不清）。
    - 规范化留着中文这类没有大小写的字（"代码 审查" → `代码-审查`），下划线、点换成 `-`。
    - 子进程里"点名才用"那一段的说法改成"说出它的名字（或者写 /目录名：location 里 SKILL.md 所在的那一层目录）就算点名"。
  - **测试**：单元 `test/toolkit/skill-command.test.ts`（重写）、`skill-collections.test.ts`（目录名规范化）、`launch-intent.test.ts` 照旧过；主切面新加 `test/main/slash-commands.test.ts`（秘书：`/mp-tdd`、`/fancy-mode` 展开，`/Fancy Mode` 原样，`/fake-set:tdd`，`/流程` 仍建流程、`/skill:流程` 是同名 skill，`/nope` 原样，候选列表；项目、任务的维护者：候选和展开，起草时为空，没有的会话 404）；前端 `packages/web/test/state/slash-commands.test.ts`；协议 `http.test.ts` 加一条路由。变基到 `d6a3ab03` 之后，用进程列表确认没有别的 vitest 全量在跑（另一个工作区只在跑单个文件），在 Git Bash 里 `ERGOU_TEST_WORKERS=2` 全量一次全绿：241 个文件、3559 条（日志在 worktree 的 `full-test-82.log`；按主会话定的三处改完后又跑一次全量，同样 241 个文件、3559 条全过，`full-test-82b.log`）；`npm run typecheck`、oxlint 0 报错。截图在变基后重拍。

- 2026-10-10 完成：命令名严格等于目录名、目录名一律小写不带空格（用户定）；主会话定集合成员不合规照改名并在导入报告提醒、单个 skill 和自带同名拒绝、命令优先只在命令存在的会话里成立。主会话看过候选列表截图；全量 3559 条通过。压缩合并进 main。
