// 按 schema 校验一个值：守护进程校验卡片负载、卡片动作的输入、秘书工具的参数时用。
// 用共享协议包自己的那份 TypeBox 编译（schema 也是它定义的）；守护进程自己的 schema（比如秘书工具的参数）
// 也用这里转出去的 Type 来写，不另外引用 TypeBox，免得两个版本混用。
import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";

export { Type };
export type { Static, TSchema };

export interface SchemaChecker<T> {
  /** 合不合 schema */
  check(value: unknown): value is T;
  /** 不合时第一条错误（"/路径 说明"）；合就是 undefined */
  firstError(value: unknown): string | undefined;
}

export function schemaChecker<S extends TSchema>(schema: S): SchemaChecker<Static<S>> {
  const validator = Compile(schema);
  return {
    check: (value): value is Static<S> => validator.Check(value),
    firstError(value) {
      if (validator.Check(value)) return undefined;
      const first = validator.Errors(value)[0];
      return first ? `${first.instancePath || "/"} ${first.message}` : "不合 schema"; // @i18n-ignore model：工具参数、配置文件的校验
    },
  };
}
