# 72 — skill 库：导入用户挑的 skill，秘书也能用 skill

Status: ready-for-agent
Blocked by: 70（同样改 agent 的装配）
Spec: [第一阶段规格](../spec.md) 第 20 节 skill 库；27 号票

## What to build

用户 2026-10-10 挑了要导进二狗 skill 库的 skill：

- 来自 `~/.pi/agent/skills`：`agent-browser`（浏览器自动化）、`yt-dlp`（下载视频图片）。（`poster-design` 用户 2026-10-10 去掉了。）
- matt-pocock 的 engineering 一套 18 个（`~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/<版本>/skills/engineering/`）：ask-matt、code-review、codebase-design、diagnosing-bugs、domain-modeling、grill-with-docs、implement、improve-codebase-architecture、prototype、research、resolving-merge-conflicts、setup-matt-pocock-skills、tdd、to-spec、to-tickets、triage、wayfinder、wizard。
- **pstack**（用户 2026-10-10 要求下载导入）：poteto（Lauren Tan）的工程方法论，来源 Cursor 官方插件仓库 `github.com/cursor/plugins` 的 `pstack/`，v0.15.15，MIT，51 个 skill（入口 `poteto-mode`，23 条 `principle-*`，以及 architect、tdd、unslop 等）。主会话已下载到会话的 scratchpad，导入时由主会话提供路径。**和 matt-pocock 的 `tdd` 重名**：用户 2026-10-10 定，**matt-pocock 的改名叫 `mp-tdd`**（只改目录名和 SKILL.md 里的 name，内容不动）；pstack 的保留 `tdd`。导入时支持"导入并改名"。

要做的：

- **导入能装下这些 skill**：现在导入限制整个目录 20 MB、2000 个文件，自带 `node_modules` 的 skill 可能超限。改成：大的依赖目录可以不复制、按原路径引用（或者放宽上限并写明），导入时报告每个 skill 导入成功与否。
- **秘书也能用 skill**：现在只有执行中的维护者和项目维护者对话时才有 skill。秘书默认装 `agent-browser`、`yt-dlp`；在设置的 skill 库页能给秘书勾选、取消。
- **agent-browser** 靠环境变量 `AGENT_BROWSER_EXECUTABLE_PATH` 找浏览器，70 号票会在拉起 agent 时注入；本票确认导入后它在秘书和维护者那里都能用（有一条手动冒烟说明，不进 CI）。
- **维护者**：开发类的项目和任务，工具包的 skill 选择里能选 matt-pocock、pstack 这两套；默认不自动装，由用户或 `adjust_skills` 选。
- **按集合显示**（用户 2026-10-10 要求）：设置里的 skill 库页，matt-pocock、pstack 这两套**不一个一个列**，各显示成一个集合：一行写集合名、来源、版本、几个 skill、一句说明，点进去才看到里面每个 skill。单个导入的（agent-browser、yt-dlp、框架自带的示例）照旧一个一个列。
  - 导入时能把一个目录作为一个集合导入，记下集合名、来源、版本；集合里每个 skill 仍是库里独立的名字（重名规则不变）。
  - 工具包和秘书的 skill 选择里，集合同样显示成一项：可以整套选，点开也能单选其中几个。
- 导入本身由主会话在合并上线后经设置页（或接口）做，导进用户的数据目录 `C:\Users\catmaniii\.ergou\skills`，**不把第三方 skill 提交进仓库**。

## Acceptance criteria

- [ ] 能导入带依赖目录的 skill（测试里用一个带假 `node_modules` 的 skill）。
- [ ] 秘书的装配带上它选中的 skill；设置里能改，下次装配生效。
- [ ] 同名冲突照旧被拒，并说清是和谁重名。
- [ ] skill 库页里 matt-pocock、pstack 各显示成一个集合，点进去才列出成员；选择 skill 时能整套选，有测试。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- skill 库在 `packages/daemon/src/skills/library.ts`；装配时经宿主协议 `skillPaths` 交给 pi 的 `additionalSkillPaths`。
- matt-pocock 这套是写给 Claude Code 的，里面提到的子 agent、斜杠命令在 pi 里不一定都有，导进来照原样，不改内容。

## Comments
