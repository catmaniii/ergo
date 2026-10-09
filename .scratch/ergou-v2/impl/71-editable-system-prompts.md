# 71 — 各 agent 的系统提示放进可编辑的 md 文件

Status: ready-for-agent
Blocked by: 70（会改秘书的系统提示）
Spec: [第一阶段规格](../spec.md) 秘书、维护者的说明；参考 drama_maker 的 `prompts/*.md`

## What to build

用户 2026-10-10 定：照 drama_maker，把二狗各 agent 的系统提示从代码里挪到 md 文件，用户能直接改。

- 默认的提示放在程序目录（比如 `packages/daemon/prompts/<角色>.md`），进仓库：秘书、任务维护者（起草、执行）、项目维护者（对话、工单）、多项目维护者、子 agent、评审子 agent、范围审视……现在代码里的每一份系统提示都挪出来。
- 用户改的放在数据目录（`<数据目录>/prompts/<角色>.md`），有就用用户的、没有就用默认的；另可放一份 `prefix.md`，加在所有提示前面（同 drama_maker 设置里的前缀）。
- 提示里要动态填的部分（名字占位、工具清单、任务书、阶段等）用占位符，代码里填；占位符写错、缺失时启动报清楚的错误，不默默用空串。
- 下一次装配 agent 时读新文件（不用重启守护进程）；设置里有一页能看到每个角色现在用的是默认还是用户改过的、一键恢复默认。

## Acceptance criteria

- [ ] 代码里不再有整段的系统提示字符串（短的一两句工具说明不算）。
- [ ] 改数据目录里的 md 后，下一次装配就生效；有测试。
- [ ] 占位符校验、恢复默认有测试。
- [ ] 录像里的系统提示没变（挪位置不改内容），或者重录并写明差别。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- drama_maker 的做法见 `D:\code\claudecode\drama_maker\server\pi\session.js`、`index.js` 的 agentSysFile 映射。
- 名字占位（43 号票）照旧。

## Comments
