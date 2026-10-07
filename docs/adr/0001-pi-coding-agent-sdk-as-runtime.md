# 运行时底座用 pi-coding-agent SDK，包在二狗自己的薄封装之后

二狗的 agent 运行时基于 `@earendil-works/pi-coding-agent` 的 SDK（`createAgentSession()` / `AgentSession`）构建。pi 的类型只出现在二狗自己的 `runtime/` 封装层里，上层（秘书、任务、审批、网关）只依赖二狗定义的接口。选它，是因为它现成提供了会话树持久化、上下文压缩、回退加分支摘要（`navigateTree`）、不进上下文的自定义记录、扩展钩子（`tool_call` 等）和 skill 加载。这正是 AgentSense 所依赖、而维护者长期会话离不开的那一整套能力。

## Considered Options

- **pi-durable**：崩溃续跑和子 agent 原语最完整，实测可用。但它自称 "Experimental"，5 天里出了 2 个 breaking 版本。用户 2026-10-07 明确排除。
- **pi-agent-core 的 `Agent` + 全部自建**：接口面最小，但会话树、压缩（1.0 已删除）、回退摘要、持久化都要自己写，等于重写 pi 刚删掉的 AgentHarness。
- 调研依据：`docs/research/10-pi-layer-mapping.md`。

## Consequences

- **二狗要自建**：
  - 崩溃续跑与待审批恢复：事件日志、任务状态机、持久化审批表，放在二狗自己的数据库里；
  - 子 agent 的父子关系与通信协议；
  - 可续传的 UI 事件流。
- **要关掉 SDK 的 CLI 行为**：它默认会在当前目录发现资源、读 `~/.pi` 配置和 auth 文件，这些都要关闭。它的依赖链也较重（TUI、MCP、codemode 等）。
- **版本管理**：
  - 所有 `@earendil-works/*` 包精确锁定，配合 npm `overrides` 和 lockfile；
  - 0.74 以来已有 9 个带 breaking 的版本；
  - 用基于 faux provider 的合同测试作为升级闸门。
- **缓存**：在 `deepseek-flash` 上分段更新 system prompt 会打穿前缀缓存。「记忆边界」已经避开这一点：用户卡放在 system 段，每天最多刷新一次；记忆简报和看板变化作为消息追加在对话尾部。
- **换底座的代价**：领域状态（审批、任务、记忆、账本）不存进 pi 的会话，只存在二狗自己的库里。将来换底座只需重写 `runtime/`。
