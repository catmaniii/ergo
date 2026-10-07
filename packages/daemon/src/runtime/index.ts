// 运行时封装层的对外接口（ADR-0001、ADR-0004）。
// 上层只从这里取东西；这里导出的全是二狗自己的类型，pi 的类型不出 runtime/ 目录。
export * from "./host-protocol.ts";
export { spawnAgentProcess, type AgentExit, type AgentProcess, type SpawnAgentProcessOptions } from "./agent-process.ts";
