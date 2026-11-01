// 从 codex app-server generate-json-schema --experimental 生成的协议 schema 里裁出二狗用到的那部分，写成 test/fixtures/codex-app-server.schema.json：
// 适配子进程发的请求、假 app-server（test/helpers/fake-codex-app-server.ts）发的回复和通知都按它校验（test/helpers/codex-schema.ts），
// 这样假的和真的协议对得上。Codex 升级、要多用一个方法时重新跑一次（临时的 CODEX_HOME，不联网、不发轮次）：
//   CODEX_HOME=<临时空目录> codex app-server generate-json-schema --experimental --out <目录>
//   node packages/daemon/test/fixtures/trim-codex-schema.mjs <目录> <codex 版本>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [dir, version] = process.argv.slice(2);
if (!dir || !version) {
  console.error("用法：node trim-codex-schema.mjs <generate-json-schema 的输出目录> <codex 版本>");
  process.exit(1);
}
const whole = JSON.parse(fs.readFileSync(path.join(dir, "codex_app_server_protocol.schemas.json"), "utf8"));

// 适配子进程、一次性子进程用到的方法 → 回复的定义名（请求的参数从 ClientRequest 里查）
const REQUESTS = {
  initialize: "InitializeResponse",
  "thread/start": "ThreadStartResponse",
  "thread/resume": "ThreadResumeResponse",
  "thread/fork": "ThreadForkResponse",
  "thread/list": "ThreadListResponse",
  "thread/read": "ThreadReadResponse",
  "thread/turns/list": "ThreadTurnsListResponse",
  "thread/unsubscribe": "ThreadUnsubscribeResponse",
  "thread/compact/start": "ThreadCompactStartResponse",
  "turn/start": "TurnStartResponse",
  "turn/steer": "TurnSteerResponse",
  "turn/interrupt": "TurnInterruptResponse",
  "hooks/list": "HooksListResponse",
  "skills/extraRoots/set": "SkillsExtraRootsSetResponse",
  "config/read": "ConfigReadResponse",
  "account/read": "GetAccountResponse",
  "model/list": "ModelListResponse",
};
// app-server 发来的请求 → 回复的定义名（请求的参数从 ServerRequest 里查）
const SERVER_REQUESTS = {
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalResponse",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalResponse",
  "item/permissions/requestApproval": "PermissionsRequestApprovalResponse",
  "item/tool/requestUserInput": "ToolRequestUserInputResponse",
  "item/tool/call": "DynamicToolCallResponse",
  "mcpServer/elicitation/request": "McpServerElicitationRequestResponse",
  applyPatchApproval: "ApplyPatchApprovalResponse",
  execCommandApproval: "ExecCommandApprovalResponse",
};
// 适配子进程认的通知
const NOTIFICATIONS = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "thread/started",
  "thread/tokenUsage/updated",
  "error",
  "model/rerouted",
  "account/rateLimits/updated",
  "hook/started",
  "hook/completed",
  "configWarning",
];

const refOf = (name) => (whole.definitions.v2[name] ? `#/definitions/v2/${name}` : whole.definitions[name] ? `#/definitions/${name}` : undefined);
const needRef = (name) => {
  const ref = refOf(name);
  if (!ref) throw new Error(`schema 里没有 ${name}`);
  return ref;
};

/** union（ClientRequest、ServerRequest、ServerNotification）里按 method 查 params 的引用 */
function paramsOf(union, method) {
  const found = whole.definitions[union].oneOf.find((entry) => entry.properties?.method?.enum?.includes(method));
  if (!found) throw new Error(`${union} 里没有 ${method}`);
  const params = found.properties.params;
  return params ? params : undefined;
}

const out = { requests: {}, serverRequests: {}, notifications: {} };
for (const [method, response] of Object.entries(REQUESTS)) out.requests[method] = { params: paramsOf("ClientRequest", method) ?? true, response: { $ref: needRef(response) } };
for (const [method, response] of Object.entries(SERVER_REQUESTS)) out.serverRequests[method] = { params: paramsOf("ServerRequest", method) ?? true, response: { $ref: needRef(response) } };
for (const method of NOTIFICATIONS) out.notifications[method] = paramsOf("ServerNotification", method) ?? true;

// 引用到的定义的闭包
const kept = new Map();
function keep(node) {
  if (Array.isArray(node)) return node.forEach(keep);
  if (typeof node !== "object" || node === null) return;
  if (typeof node.$ref === "string" && !kept.has(node.$ref)) {
    const parts = node.$ref.replace("#/definitions/", "").split("/");
    const target = parts.reduce((at, key) => at[key], whole.definitions);
    kept.set(node.$ref, target);
    keep(target);
  }
  for (const [key, value] of Object.entries(node)) if (key !== "description") keep(value);
}
keep(out);

/** 去掉说明文字（只留形状，文件小一些） */
function bare(node) {
  if (Array.isArray(node)) return node.map(bare);
  if (typeof node !== "object" || node === null) return node;
  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" || key === "$schema" || key === "title") continue;
    copy[key] = key === "properties" ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, bare(schema)])) : bare(value);
  }
  return copy;
}

const definitions = { v2: {} };
for (const [ref, schema] of [...kept].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
  const parts = ref.replace("#/definitions/", "").split("/");
  if (parts[0] === "v2") definitions.v2[parts[1]] = bare(schema);
  else definitions[parts[0]] = bare(schema);
}
const target = fileURLToPath(new URL("./codex-app-server.schema.json", import.meta.url));
fs.writeFileSync(target, `${JSON.stringify({ codexVersion: version, ...bare(out), definitions }, null, 1)}\n`);
console.log(`写好了 ${target}：${kept.size} 个定义，${fs.statSync(target).size} 字节`);
