// 组件（323 号票）的请求体。名字和别的形状在 components.ts（不引用 TypeBox）。
// 装、删、暂停、继续、取消本来就是按组件现在的状态来的（装着的再装一次没有变化、没在下的暂停什么都不做），所以不带幂等键。
// - POST /api/components/<id>：对一个组件做的事；
// - POST /api/components：装上照默认该装、还没装的（install_defaults）；
// - POST /api/component-import：离线导入——这台电脑上的一个路径（一个文件、一个文件夹，或者一个 .tar / .tgz 包），
//   守护进程按清单里的大小和校验值认，认得的放进去、凑齐了就装上；不认得的不用。路径是守护进程那台电脑上的（和设置里导入 skill 一样）。
import { type Static, Type } from "typebox";
import { COMPONENT_ACTIONS } from "./components.ts";

export const ComponentActionBody = Type.Object({ action: Type.Enum(COMPONENT_ACTIONS) }, { additionalProperties: false });
export type ComponentActionBody = Static<typeof ComponentActionBody>;

export const ComponentsActionBody = Type.Object({ action: Type.Literal("install_defaults") }, { additionalProperties: false });
export type ComponentsActionBody = Static<typeof ComponentsActionBody>;

export const ComponentImportBody = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
export type ComponentImportBody = Static<typeof ComponentImportBody>;
