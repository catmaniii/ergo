// 运营接口清单（ops.json）的问题和提醒（268 号票）：读清单（manifest.ts）、清单验收（acceptance.ts）查出来的，存成 key 加参数
// （事件里、验收结果里都是这个样子，和语言无关），用到时再按语言说出来——转运营检查清单（卡上，给用户看）用当前的语言，
// 交给秘书、维护者的（工具结果）用 forModel 说成模型的语言。key 都在 projectOps.problem.* 下（语言文件 projectOps.json）。
import { forModel, newNameOf, t } from "@ergo/protocol";

/** 一条问题或提醒：projectOps.problem.<code> 的 code 和参数 */
export interface OpsMsg {
  code: OpsProblemCode;
  params?: Record<string, string | number>;
}

/** 所有的 code（每个都要在语言文件里有 projectOps.problem.<code>，单元测试逐个说一遍） */
export const OPS_PROBLEM_CODES = [
  // 读清单（格式）
  "readFailed",
  "notJson",
  "topNotObject",
  "endpointNotObject",
  "endpointService",
  "endpointPath",
  "noTools",
  "opNotObject",
  "opNoName",
  "opBadName",
  "opDuplicate",
  "opReserved",
  "titleNotString",
  "descriptionNotString",
  "userSaysNotStrings",
  "returnsNotString",
  "usageNotString",
  "inputSchemaNotObject",
  "inputSchemaType",
  "annotationsNotObject",
  "readOnlyHintNotBool",
  "kindInvalid",
  "kindConflict",
  "riskInvalid",
  "implNotObject",
  "implTypeInvalid",
  "scriptFile",
  "scriptExt",
  "scriptArgs",
  "ergoAction",
  "ergoParams",
  "maintainerInstructions",
  "testNotObject",
  "testArgsNotObject",
  "testSayIncludes",
  // 验收：格式对（每个操作写全了）
  "missingTitle",
  "missingDescription",
  "missingUserSays",
  "missingKind",
  "missingTest",
  "schemaUnusable",
  "schemaPropNotObject",
  "schemaRequiredUnknown",
  "schemaEnumNames",
  "schemaEnumNamesLength",
  "schemaDefaultInvalid",
  "testArgsInvalid",
  "placeholderUnknown",
  "scriptMissing",
  "endpointUnknownService",
  "endpointAmbiguous",
  "endpointNoService",
  "maintainerUnavailable",
  // 验收：每个操作一条能跑通的测试、只读的真不写
  "testFailed",
  "testNoSay",
  "testSayMismatch",
  "testWrote",
  "testWaiting",
  // 提醒（不挡验收）
  "warnManyParams",
  "warnNested",
  "warnNoDefault",
] as const;
export type OpsProblemCode = (typeof OPS_PROBLEM_CODES)[number];

/** 一条问题 */
export const problem = (code: OpsProblemCode, params?: Record<string, string | number>): OpsMsg => (params ? { code, params } : { code });

/** 按当前的语言说出来（卡上给用户看的）；312 号票：早先存下的 code 里的旧写法（ergouAction 这种）换成新的再查 */
export const problemText = (m: OpsMsg): string => t(`projectOps.problem.${newNameOf(m.code)}`, m.params);

/** 说成模型的语言（交给秘书、维护者的工具结果） */
export const problemForModel = (m: OpsMsg): string => forModel(() => problemText(m));
