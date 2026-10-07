// 运行时封装层的对外接口（ADR-0001、ADR-0004）。
// 上层只从这里取东西；这里导出的全是二狗自己的类型。pi 只出现在 agent-child/ 里，
// 那个目录只作为子进程入口由 agent-process.ts 按路径拉起，不被别的模块 import。
export * from "./host-protocol.ts";
export { spawnAgentProcess, type AgentExit, type AgentProcess, type SpawnAgentProcessOptions } from "./agent-process.ts";
