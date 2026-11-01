// 项目的服务给秘书的工具名：提示词里的占位符 {{open_service}} 照它（prompts/registry.ts），工具本身在 secretary-tool.ts。
export const OPEN_SERVICE_TOOL = "open_service";
// 秘书启动、关闭项目的服务（和项目卡片、项目页上的按钮同一个入口），占位符 {{switch_project_services}}。
export const SWITCH_SERVICES_TOOL = "switch_project_services";
// 负责人查自己项目的服务最近报的事件（只读），占位符 {{recent_service_events}}。
export const RECENT_SERVICE_EVENTS_TOOL = "recent_service_events";
