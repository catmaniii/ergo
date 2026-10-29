// 我的名字（用户自己的名字，249 号票）：服务在 user-name.ts，设置接口在网关（GET / PUT /api/user-name），
// 进系统提示的路径是组合根把现取的名字交给系统提示（prompts/library.ts 的前缀）。
export { createUserNameService, type UserNameService } from "./user-name.ts";
