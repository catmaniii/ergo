// 角色（248 号票）：名字 + 音色绑成一个角色，设置 · 角色与声音里维护，每个 agent 只选一个。
// 实现在 agent-roles.ts（存、校验、迁移、回退）；旧配置读在 legacy-profiles.ts（只在第一次迁移时用）。
export * from "./agent-roles.ts";
export * from "./legacy-profiles.ts";
