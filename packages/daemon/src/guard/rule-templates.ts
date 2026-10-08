// v1 规则模板（规格第 9 节）：框架自带、默认生效的六条时序规则，不用写进计划。用 planguard 的格式写，和计划里的规则走同一个引擎。
// 触发它们的工具按工具注册表算（比如"对外发送"也包括登记了 outbound 的 MCP 工具），所以模板是注册表的函数。
// 规则里用到的 $current.paths、$current.sends 这些字段见 rule-steps.ts。
//
// 违反了怎么办分三种（on_violation）：
// - 前提没满足、agent 自己能补救的，按规则退回（pull_back）：1、2；
// - 一律禁止的，和对外内容含密钥：永不（block）：3、5、6；
// - 重复发可能是正常需求（比如每天发同样的通知）：先问我（confirm）：4。
//
// 1. 删除或覆盖项目档案和工作目录里的文件之前，必须已备份或已 git 提交。秘书草稿区不受约束（只看 area 为 project 的路径）；
//    "删除或覆盖"指删除文件、整体重写已有文件（局部编辑不算），以及带"删除或覆盖"标签的工具（丢弃 git 改动）；
//    "已提交"看调用方传入的 git 状态（项目档案不在 git 里，一律不算），"已备份"看环境事实里的 backedUp
//    （项目档案由运行时自动留旧版本，07、15 号票传 true），或效果日志里之前把它（或它所在的目录）复制出去过。
// 2. push 之前必须在同一个仓库里跑过测试（测试没通过不进效果日志，不算）。
// 3. 读过 .env 或密钥文件之后，不许对外发送、不许发 HTTP 请求——一律禁止，不是先问。"对外发送、发请求"按最严算：
//    凡是联网的工具、会把内容发出去的工具、"以我的名义对外发送"的工具，以及环境事实里报了用到联网库的脚本（没扫过的判断不了）。
//    （和 13 号票控制器里的硬检查"某个对象被判过永不之后，再对它做对外动作要先问"是两条不重叠的规则。）
// 4. 同一收件人、同一内容不重复发：对外发送之前给其中任何一个收件人发过一模一样的内容就先问；只读的 GET 不算。
//    没有收件人参数的发送（推送、gh 评论……）用目标对象当收件人（rule-steps.ts 的 recipients）。
// 5. 对外内容不许含密钥：和底线"把凭据写进对外内容"用同一套密钥形态正则、同一个取内容的口径（secrets.ts）。
// 6. force push 和项目外的 rm -rf（递归删除项目档案、工作目录之外——秘书是草稿区之外——的东西）一律禁止。
import type { TemporalRule } from "./temporal-rules.ts";
import { pathReplacement, READ_ONLY_HTTP_METHODS, sendsOut, TOOL, type ToolDescriptor, type ToolRegistry } from "./tool-registry.ts";

/** v1 模板的规则 id */
export const V1_TEMPLATE_IDS = Object.freeze({
  backupBeforeOverwrite: "v1.backup-before-overwrite",
  testBeforePush: "v1.test-before-push",
  noSendAfterSecretRead: "v1.no-send-after-secret-read",
  noDuplicateSend: "v1.no-duplicate-send",
  noSecretInOutbound: "v1.no-secret-in-outbound",
  noForcePushOrRmRfOutside: "v1.no-force-push-or-rm-rf-outside",
} as const);

/** 按注册表记下生成好的模板：注册表和生成出来的规则对象都不可变，可以一直复用 */
const cache = new WeakMap<ToolRegistry, readonly TemporalRule[]>();

/** 按工具注册表生成 v1 模板（同一个注册表只生成一次） */
export function v1RuleTemplates(tools: ToolRegistry): readonly TemporalRule[] {
  let rules = cache.get(tools);
  if (!rules) {
    rules = Object.freeze(buildTemplates(tools));
    cache.set(tools, rules);
  }
  return rules;
}

/** 不是只读的 HTTP 方法（参数不存在时也算，比如发邮件的工具没有 method） */
const notReadOnly = (method: string) => ({ not: { in: [method, READ_ONLY_HTTP_METHODS] } });
const pathArgs = (t: ToolDescriptor) => Object.values(t.args).filter((a) => a.kind === "path");

function buildTemplates(tools: ToolRegistry): TemporalRule[] {
  const all = Object.values(tools);
  const names = (pick: (t: ToolDescriptor) => boolean) => all.filter(pick).map((t) => t.name);

  /** 会删除或整体重写文件的工具 */
  const replacing = names((t) => pathArgs(t).some((a) => pathReplacement(t, a) !== undefined));
  /** 会读文件的工具（路径参数是读，或者不知道读还是写） */
  const reading = names((t) => pathArgs(t).some((a) => a.access !== "write" && a.access !== "delete"));
  /** 可能联网发东西的工具（跑脚本要看环境事实，由 $current.sends 定） */
  const sending = names((t) => sendsOut(t) || t.name === TOOL.run_script);
  /** 会把内容发出去的工具 */
  const outbound = names((t) => t.outbound === true);
  /** 对外发送：带"以我的名义对外发送"标签的，以及会把内容发给某个收件人或网址的（发 HTTP 请求按方法区分） */
  const delivering = names(
    (t) => t.categories.includes("external_send") || (t.outbound === true && Object.values(t.args).some((a) => a.kind === "recipient" || a.kind === "url")),
  );

  return [
    {
      id: V1_TEMPLATE_IDS.backupBeforeOverwrite,
      title: "删除或覆盖项目档案和工作目录里的文件之前，必须已备份或已 git 提交",
      trigger: { tool: replacing },
      for_each: { var: "p", key: "$p.path", in: { select: { from: "$current.paths", where: { ne: ["$row.access", "read"] } } } },
      when: { and: [{ eq: ["$p.replaced", true] }, { eq: ["$p.area", "project"] }] },
      unless: { or: [{ eq: ["$p.committed", true] }, { eq: ["$p.backedUp", true] }] },
      require: { before: { tool: TOOL.copy, where: { path_within: ["$p.path", "$prior.args.from"] } } },
      message:
        "「{p.path}」还没有 git 提交、也没有备份。先提交（git_commit），或者先复制一份备份（cp），再删除或覆盖；只改已有文件的一部分请用 edit 局部修改",
      on_violation: "pull_back",
    },
    {
      id: V1_TEMPLATE_IDS.testBeforePush,
      title: "push 之前必须跑过测试",
      trigger: { tool: TOOL.git_push },
      require: { before: { tool: TOOL.run_tests, where: { path_within: ["$current.args.repoPath", "$prior.args.repoPath"] } } },
      message: "推送之前要在这个仓库里成功跑过测试。先单独跑一次测试（run_tests，或 bash 里的 npm test），通过后再推送",
      on_violation: "pull_back",
    },
    {
      id: V1_TEMPLATE_IDS.noSendAfterSecretRead,
      title: "读过 .env 或密钥文件之后不许对外发送、不许发 HTTP 请求",
      trigger: { tool: sending },
      when: { eq: ["$current.sends", true] },
      require: {
        not_before: {
          tool: reading,
          where: { any: { from: "$prior.paths", where: { and: [{ eq: ["$row.secretFile", true] }, { in: ["$row.access", ["read", "unknown"]] }] } } },
        },
      },
      message: "之前读过 .env 或密钥文件，之后一律不许对外发送、不许发 HTTP 请求。这一步不能做；确实需要的话，请用户亲自处理",
      on_violation: "block",
    },
    {
      id: V1_TEMPLATE_IDS.noDuplicateSend,
      title: "同一收件人、同一内容不重复发",
      trigger: { tool: delivering },
      when: { and: [{ present: "$current.recipients" }, notReadOnly("$current.args.method")] },
      require: {
        not_before: {
          tool: delivering,
          where: {
            and: [
              notReadOnly("$prior.args.method"),
              { eq: ["$prior.content", "$current.content"] },
              { any: { from: "$current.recipients", as: "r", where: { in: ["$r", "$prior.recipients"] } } },
            ],
          },
        },
      },
      message: "之前已经给同一个收件人（{current.recipients}）发过一模一样的内容了，再发一次要用户确认",
      on_violation: "confirm",
    },
    {
      id: V1_TEMPLATE_IDS.noSecretInOutbound,
      title: "对外内容不许含密钥",
      trigger: { tool: outbound },
      require: { check: { eq: [{ len: "$current.secrets" }, 0] } },
      message: "要发出去的内容里有密钥形态（{current.secrets}）。把密钥从内容里去掉再发；需要凭据的地方请用户自己配置",
      on_violation: "block",
    },
    {
      id: V1_TEMPLATE_IDS.noForcePushOrRmRfOutside,
      title: "force push 和项目外的 rm -rf 一律禁止",
      trigger: { tool: names((t) => t.name === TOOL.git_push || t.name === TOOL.delete) },
      when: {
        or: [
          { eq: ["$current.args.force", true] },
          { and: [{ eq: ["$current.args.recursive", true] }, { any: { from: "$current.paths", where: { eq: ["$row.area", "outside"] } } }] },
        ],
      },
      message: "force push 和项目档案、工作目录（秘书是草稿区）之外的递归删除一律禁止。推送不要带 force；项目外的东西请用户自己删",
      on_violation: "block",
    },
  ];
}
