# 72 — skill 库：导入用户挑的 skill，秘书也能用 skill

Status: done
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

- [x] 能导入带依赖目录的 skill（测试里用一个带假 `node_modules` 的 skill）。
- [x] 秘书的装配带上它选中的 skill；设置里能改，下次装配生效。
- [x] 同名冲突照旧被拒，并说清是和谁重名。
- [x] skill 库页里 matt-pocock、pstack 各显示成一个集合，点进去才列出成员；选择 skill 时能整套选，有测试。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- skill 库在 `packages/daemon/src/skills/library.ts`；装配时经宿主协议 `skillPaths` 交给 pi 的 `additionalSkillPaths`。
- matt-pocock 这套是写给 Claude Code 的，里面提到的子 agent、斜杠命令在 pi 里不一定都有，导进来照原样，不改内容。

## Comments

- 2026-10-10 实现（worktree 分支 `worktree-agent-a567908c2ee22b59a`，从 main `bc16668e` 开始）。说明在 `docs/dev.md` 的"skill 库、MCP 登记与工具包"一节（27、72 号票），`CONTEXT.md` 加了"skill 集合"。本票只做代码，**没有读、没有改 `~/.ergou`，没有把任何第三方 skill 放进仓库**；测试里全是自己造的假 skill、假集合。
  - **导入接口**（主会话合并上线后用它导入）：`POST http://127.0.0.1:8810/api/skills/import`（`HTTP_PATHS.skillImport`），请求体 `ImportSkillBody`：
    - 单个：`{ "path": "C:\\Users\\catmaniii\\.pi\\agent\\skills\\agent-browser" }`；导入并改名加 `"rename": "新名"`。
    - 集合：`{ "path": "<根目录>", "collection": { "name", "source", "version", "description", "skillsDir"?, "rename"?: { "原名": "新名" } } }`。pstack：`path` 是插件根目录 `…\dl-pstack\plugins\pstack`，`skillsDir: "skills"`；matt-pocock：`path` 是 `…\mattpocock-skills\1.2.3\skills\engineering`（成员直接在根目录下，不写 `skillsDir`），`rename: { "tdd": "mp-tdd" }`。**先导 pstack 再导 matt-pocock**（不改名会被拒："tdd 和集合 pstack 里的 tdd 重名"）。
    - 回 `ImportSkillResult`：`skills`、`collection`、`report`（每个 skill 一行 `{ name, dir, ok, note? }`）、`linked`（按原路径引用的依赖目录）。设置的 skill 库页"＋ 导入 skill"也能做（分"单个 skill""一整套"两栏）。
    - **演练过**：用本票的库代码把真实的 agent-browser、yt-dlp、pstack、matt-pocock 导进 scratchpad 里的临时数据目录（只读来源、不执行来源里的东西，跑完删掉）：pstack 51 个、matt-pocock 18 个（`mp-tdd`）、两个单个，共 72 个（含框架自带的示例）；不改名时 matt-pocock 被拒；`poteto-help` 的 `../../docs/guide/01-setup.md`、`../../README.md`，`architect/references` 的 `../../arena/SKILL.md` 在导入后都找得到。
  - **集合的数据形状**：协议包 `SkillCollectionEntry { name, source, version, description, skills: string[] }`（`ToolkitCatalog.collections`），成员的 `SkillEntry` 多一个 `collection`。skill 区里是 `<集合名>/`（来源根目录整个复制）加 `ergou-collection.json`（`format, name, source, version, description, members: 成员目录[], renamed?: {新名: 原名}, importedFrom, importedAt, linked?`）。工具包、秘书的名单里写的始终是成员的 skill 名，集合只是显示和选择的方式。
  - **秘书用的 skill**：默认 `agent-browser`、`yt-dlp`（`DEFAULT_SECRETARY_SKILLS`，库里还没有的不装，导入后下一次装配自动装上）。改：设置 → skill 库页最上面"个人助理用的 skill"一栏勾选（集合整套选、点开单选），或 `POST /api/skills/secretary`（`{ "skills": [...] }`，整份名单，只能选库里有的；`GET` 看现在的）。存在数据目录配置区 `config/secretary-skills.json`；改了之后秘书做完手头这一条就按新名单重新装配。
  - **pstack 有没有引用 skill 目录之外的文件**：有。① 兄弟 skill：`../<别的 skill>/SKILL.md`（很多），`architect/references/rationale-template.md` 的 `../../arena/SKILL.md`；② 插件根目录：`poteto-help/SKILL.md` 引用 `../../README.md` 和 `../../docs/guide/01-setup.md`、`02`、`06`、`07`、`08`、`09`、`10`；③ 插件根目录的 `agents/poteto-agent.md`、`comment-sicko.md` 只按名字提（`subagent_type: "poteto-agent"`，Cursor 的子 agent），不是路径引用，pi 里没有这种子 agent；④ `~/.cursor/rules/pstack-models.mdc`、`~/.cursor/projects/…` 这类 Cursor 本机路径，不在插件里，带不了。**带法**：集合导入时把来源根目录（插件根目录）整个复制进来，成员在 `skills/` 下面，①②的相对路径原样对得上，`agents/`、`docs/`、`README.md`、`assets/` 一起在；`.cursor-plugin/plugin.json` 也在（没用到）。matt-pocock 的 engineering 里没有 `../` 引用，每个 skill 自己的 `agents/openai.yaml` 在 skill 目录里，一起复制。
  - **拿不准、按下面理解做了的地方**（请主会话确认）：
    - **只在用户点名时才用的 skill**：pstack 51 个 SKILL.md 里 **50 个**写了 `disable-model-invocation: true`（`setup-pstack` 没写；第一版这里误写成"全都"，已改正），matt-pocock 的 implement、to-spec、to-tickets、wayfinder、ask-matt 等也是。pi 把这类 skill 从系统提示的 skill 清单里拿掉，只能靠用户打 `/skill:名字` 展开；二狗交给 pi 的用户消息第一行是时间标记，展开永远不会发生——不处理的话 pstack 选进工具包等于没选。本票在子进程里用 pi 的 `appendSystemPromptOverride` 另起一段（`<user_invoked_skills>`：名字、说明、位置），写明"只在用户点名时才用（写了 /名字，或者说要用某个 skill）"（`runtime/agent-child/user-invoked-skills.ts`，契约测试一条、主切面一条）。这是票面没写的行为，照作者"用户点名才用"的意思做，没改 skill 内容。
    - ~~**显示名当 name 的**~~（评审后按用户的话作废，见下面"第二轮"：名字照原样，不改）：pstack 的 `poteto-mode`（入口）写的是 `name: Poteto Mode`，`make-bot-ui` 写的是 `name: Make Bot UI`，不合 skill 名的规矩，原来的规矩会拒绝。导入时改成按目录名算，并把 SKILL.md 里的 name 一行改成目录名（和"导入并改名"一样只改这一行），报告里写明。已经在 skill 区里的（手放的）照旧不认。
    - **依赖目录**：选了"不复制、按原路径引用"：`node_modules`、`.venv`、`venv`（任何一层）在原位置建目录联接指回来源；`.git` 不复制；大小上限 2000 个文件、20 MB 只算复制的部分（集合按整个根目录算）。代价：不进备份；来源删了链接就断。真实的四样都没有 node_modules，这条现在用不上。
    - **集合里有成员不合规**：跳过并在报告里写原因，别的照导；**有成员重名**：整套拒绝（让用户加改名再导），说清每个重名的和谁重名。集合名不能和 skill 名同名（维护者 `adjust_skills` 写集合名整套加时才不会认错）。同名的集合要升级：先删掉 skill 区里的目录再导（没做"更新"）。
    - **维护者**：`adjust_skills` 的 `add`、`remove` 可以写集合名（整套）；"开发类的项目和任务能选这两套"按"所有项目和任务的工具包里都能选"做，开发类不特别处理，默认不装。计划（`submit_plan`）里的工具包仍要写 skill 名，写集合名会被"skill 库里没有"拒绝。
    - 工具包区的选择换成共用的 `ui/skill-picker.tsx`（集合显示成"pstack（全部 51 个）""pstack（3/51）"一项，× 整套去掉，点开单选；"＋ 从 skill 库加"里有"整套：…""从 … 里挑几个…"）。时间线、计划卡上的工具包说法仍一个一个列 skill 名（整套 51 个会很长），没改。
    - matt-pocock、pstack 里提到的子 agent、斜杠命令、Cursor 的本机路径在 pi 里多半用不了，照票面原样导入、不改内容。
  - **agent-browser 的手动冒烟**（不进 CI）写在 `docs/dev.md` 那一节：导入后对秘书说"用 agent-browser 打开 https://example.com 截个图发我"，维护者同样（工具包加上 agent-browser、开 bash）。本票没跑（没有真的导入）。
  - **测试**：单元 `test/toolkit/skill-collections.test.ts`（带假 node_modules 的 skill、导入并改名、集合、显示名按目录名、秘书用的 skill）、`library-registration.test.ts` 跟着改；主切面 `test/main/skill-collections.test.ts`（经 HTTP 导入集合和改名、重名被拒说清和谁、秘书默认的和改了之后的装配、点名才用的那一段、维护者写集合名整套加）、`toolkit.test.ts` 跟着改；契约 `toolkit.contract.test.ts` 多一条；前端 `packages/web/test/state/skill-groups.test.ts`（按集合显示、整套选、单选）。截图（原型假数据）：scratchpad 的 `t72/skills-390.png`、`skills-1280.png`。
  - **两轴评审后改了的**：设置页改秘书名单时不再丢掉还没导入的默认项（agent-browser、yt-dlp 改过名单后照样可以先于导入留着，导入后自动装上，别的只能选库里有的；单元测试补了一条）；界面上、设置页显示的问题、HTTP 报错里提到秘书的改成名字占位或用户起的名字；"默认装……"取 `DEFAULT_SECRETARY_SKILLS`；Web 里的 set 叫法统一成 collection（`skill-collection-*`、`chip-collection`），`CollectionPick.pick` 改名 `state`；删掉没人用的 `SkillLibrary.has` 和 `SkillPicker` 的 `disabled`。没改的：库里的说法留在 `skills/library.ts`（27 号票起就在那里，不在 toolkit/ 的范围）；`user-invoked-skills.ts` 里写死的 read 是 pi 的工具名；`library.ts` 一个文件管扫描、导入、说明文件，没拆。评审提的"票面没要求"两处（点名才用的那一段、显示名按目录名）照旧，在上面请主会话确认。
  - 变基到 main `67bc4d61`（81 号票开票），用进程列表确认没有别的 vitest 在跑之后，在 Git Bash 里 `ERGOU_TEST_WORKERS=2` 全量一次全绿：234 个文件、3496 条；`npm run typecheck`、oxlint 0 报错。截图（原型假数据，390 和 1280 各一张）在会话 scratchpad 的 `t72/`。

- 2026-10-10 评审后的修改（第二轮，同一分支）：
  - **【阻塞】导入不再跟任何链接**：原来认 `node_modules` 时跟着链接走、不查指到哪，来源里一个指向数据目录密钥区的联接会被原样联进 skill 区。改成导入前把来源（真实路径）整个用 lstat 看一遍（`library.ts` 的 `planSource`）：来源目录本身是链接的拒绝；复制的部分里有符号链接、目录联接的**整个拒绝**（不论指向哪，报错里列出是哪个、指向哪）；依赖目录本身不能是链接；依赖目录里的链接只认真实路径在来源目录里面的（npm、pnpm 的工作区链接），指向别处的也整个拒绝。复制时再挡一道（之后才冒出来的链接不复制），建依赖目录的联接前再核一次。选"拒绝"而不是"复制链接指向的内容"：更简单，也不会把来源外面的东西悄悄带进来。测试：联接指向密钥区、数据目录、来源之外三种，分别放成 `node_modules` 本身、单个 skill 里的 `refs`、集合根目录下的 `docs/linked`、`node_modules` 里的 `sneaky`，都拒绝、skill 区里什么都没留下；来源目录本身是联接的拒绝；`node_modules` 里指向来源里面的工作区链接照常（单元 `skill-collections.test.ts`，主切面一条经 HTTP 的）。
  - **【用户定】不改 skill 的名字**：去掉"显示名按目录名改 name"。名字照 SKILL.md 原样认、照原样用（"Poteto Mode"、"Make Bot UI" 一字不改），规则放宽成和 pi 一样只提示：只挡空的、超过 200 个字的、带控制字符的；不是小写短横线写法的，报告里提一句"照原样用"。重名按原来的名字判。内部的稳定键是目录：单个 skill 在 skill 区里的目录名改成取来源的目录名（导入并改名的取新名字），集合是 `<集合名>/<成员目录>`，都不回写到文件里。唯一的例外照旧：matt-pocock 的 `tdd` → `mp-tdd` 只改目录名和 name 一行。宿主协议交给 pi 的是目录路径，pi 自己读名字；主切面测了名字带空格的 skill 在秘书的系统提示里就是 `<name>Fancy Mode</name>`（pi 只告警、照常加载）。演练（同上一轮，scratchpad 里的临时数据目录）：pstack 51 个全进来了，`Poteto Mode`、`Make Bot UI` 照原样。
  - **点名才用**：维持列进提示的做法，说法改成"说出它的名字（或者写 /名字）就算点名"。另加：用户在输入框里打 `/skill:名字`，守护进程在加时间标记之前展开（`skills/skill-command.ts`，写法照 pi 的 `/skill:` 展开；名字可以带空格、按最长的匹配，写目录名也认；只认这个会话装配了的 skill）。单元 `skill-command.test.ts`，主切面测了秘书收到的是"时间标记 + 展开的 skill 全文 + 其余的话"。
  - **秘书的提示长度**：秘书用的 skill 的接口多带 `promptChars`、`promptBytes`（照 pi 列 skill 的写法估名字、说明、位置），skill 库页上写"这些 skill 的说明在系统提示里一共约 N 字（X KB）"，超过 8 KB（`SECRETARY_SKILL_PROMPT_WARN_BYTES`）提醒一句。
  - **不带的东西**（集合和单个 skill 都一样，任何一层）：`.git` 和别的隐藏目录（依赖目录 `.venv` 除外，成员所在的子目录那条路上的不算）、`.env`、`.env.*`、`*.pem`、`*.key`；`.gitignore` 这类普通隐藏文件照带。导入结果多一个 `excluded` 列出来（集合的说明文件里也记），导入弹层的报告里显示。pstack 根目录下的 `.cursor-plugin/` 因此不带（没被引用）。
  - **改正**：上面"pstack 的 51 个全都标了点名才用"是 50 个（`setup-pstack` 没标）。
  - 协议改名：`SKILL_NAME_PATTERN` → `IMPORT_NAME_PATTERN`（只管导入时新起的名字：集合名、改的名，它们也是目录名）。
  - 第二轮之后 main 还是 `67bc4d61`（71 号票还没合进来，不用变基）。我加的"点名才用"说明在子进程追加的那一段里（`runtime/agent-child/user-invoked-skills.ts` 的两句话），不在秘书的系统提示代码里；71 合进来后要挪进 `prompts/*.md` 的话，得经装配参数把这段话交给子进程，合并时再定。用进程列表确认没有别的 vitest 全量在跑（另一个工作区只在跑单个文件）之后，在 Git Bash 里 `ERGOU_TEST_WORKERS=2` 全量一次全绿：235 个文件、3505 条；`npm run typecheck`、oxlint 0 报错。截图已按新页面重拍（scratchpad 的 `t72/`）。

- 2026-10-10 完成：两轴评审的阻塞（导入跟链接带进密钥）已改为一律不跟链接；用户定不改 skill 名字（只有 matt-pocock 的 tdd → mp-tdd）；`/skill:名字` 展开和"说出名字"两种点名都支持；集合导入不带隐藏目录和密钥类文件。全量 3505 条通过。压缩合并进 main；随后由主会话正式导入。
