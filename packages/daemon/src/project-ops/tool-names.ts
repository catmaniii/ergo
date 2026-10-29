// 秘书调使用中的项目的操作（260 号票）的工具名：提示词里的占位符 {{project_ops}} 照它（prompts/registry.ts），工具本身在 tool.ts。
// 单独放一个文件：系统提示要引用它（经运营层的入口 api.ts），不必拉进工具的依赖。聊天里的工具调用摘要 280 号票起不再认它的名字：
// 工具自己在登记里声明参数要打码（maskArgs）。
export const PROJECT_OPS_TOOL = "project_ops";

/** 维护者验收运营接口清单（268 号票，check-tool.ts）：提示词里的占位符 {{check_ops}} */
export const CHECK_OPS_TOOL = "check_ops";
