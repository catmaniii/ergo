// 项目的服务（133 号票）：运营手段"服务"——项目做成一个服务，用户在卡上确认一次就到 LSM 上线，有网页的经二狗转发、项目卡片上有入口。
// 这里是汇总导出，给测试用。280 号票起它属于运营层（照插件的纪律写）：源码里别处只经运营层的入口 project-ops/api.ts 用它，
// 组装函数经 project-ops/layer.ts 装它（test/projects/boundary.test.ts 守着），不 import 这个文件。
// - means.ts：在运营手段登记表里登记的"服务"（校验、卡上的说法、生效、撤销、停用 / 重新启用时撤下 / 重新上线）；
// - spec.ts：一个服务写得对不对（工作目录不出界、没有密钥、端口）、补齐、交给 LSM 的定义；
// - project-services.ts：事务之后异步去 LSM 上线、撤下，接 LSM 推来的状态，登记转发，给前端、秘书看的样子；
// - secretary-tool.ts：秘书给出入口（open_service、服务入口卡）、启动关闭项目的服务（switch_project_services，257 号票）、查看板时的一节；
// - thumbnails.ts：服务首页的缩略图（140 号票：守护进程自己截、存在缓存区，什么时候截由 project-services.ts 定）；
// - events.ts / views.ts：operations 频道上的事件和派生视图；texts.ts：说法。
export { PROJECT_SERVICE_EVENTS, type ServiceDesiredPayload, type ServicePowerBy, type ServicePowerPayload, type ServiceRolloutPayload } from "./events.ts";
export { serviceMeans, type ServiceMeansDeps } from "./means.ts";
export { createProjectServices, type ProjectServices, type ProjectServicesOptions, replyReason, statusOf } from "./project-services.ts";
export {
  findServices,
  OPEN_SERVICE_TOOL,
  openServiceTool,
  serviceBoardSection,
  serviceEntryCardType,
  SWITCH_SERVICES_SETTLE_MS,
  SWITCH_SERVICES_TOOL,
  switchServicesTool,
} from "./secretary-tool.ts";
export { looksLikeSecret, lsmDefinition, normalizeService, servicePlanProblems, serviceProblems, serviceUrl, withOwnNode } from "./spec.ts";
export { projectServicesView, servicePower, serviceRow, serviceRows } from "./views.ts";
export {
  captureServiceHome,
  createServiceThumbnails,
  SERVICE_THUMBNAIL_RESTART_GAP_MS,
  SERVICE_THUMBNAIL_RETRY_MS,
  SERVICE_THUMBNAIL_SCALE,
  SERVICE_THUMBNAIL_VIEWPORT,
  type ServiceThumbnails,
  type ThumbnailReason,
} from "./thumbnails.ts";
