// 守护进程这一侧：把收到的一帧解析成类型确定的请求，或者给出错误（网关据此回错误响应，连接不断）。
// 分两步校验：先看帧本身（id、方法），再按方法校验参数，错误信息因此能说清是哪一层不对。
// 加一个方法：在 constants.ts 的 METHODS 里加名字，在 schema.ts 里定义参数，再在下面的 PARAM_SCHEMAS 里登记一项；
// 参数类型 MethodParams 和校验器都由这张表推出来。
import type { Static } from "typebox";
import { Compile } from "typebox/compile";
import { type IdempotentMethod, METHODS, type Method, requiresIdempotencyKey } from "./constants.ts";
import { CardActionParams, Channel, CreateReminderParams, type ErrorBody, InboxActionParams, RequestFrame, RevokeDeviceParams, SendMessageParams, SubscribeParams } from "./schema.ts";
import { ConvertTaskParams, NewProjectParams, ProjectActionParams, ResetMaintainerParams } from "./project-schema.ts";
import { SetVoiceAnnounceParams, StartTaskParams, TaskActionParams, TaskBatchActionParams } from "./task-schema.ts";
import { UpdateWatchCategoriesParams } from "./watch-category-schema.ts";
import { RetryVoiceParams } from "./voice-schema.ts";
import { SetToolkitParams } from "./toolkit-schema.ts";
import { RescheduleJobParams, RunJobNowParams, ScheduledJobActionParams } from "./scheduled-job-schema.ts";

/** 每个方法的参数 schema */
const PARAM_SCHEMAS = {
  [METHODS.subscribe]: SubscribeParams,
  [METHODS.sendMessage]: SendMessageParams,
  [METHODS.cardAction]: CardActionParams,
  [METHODS.inboxAction]: InboxActionParams,
  [METHODS.revokeDevice]: RevokeDeviceParams,
  [METHODS.startTask]: StartTaskParams,
  [METHODS.updateWatchCategories]: UpdateWatchCategoriesParams,
  [METHODS.newProject]: NewProjectParams,
  [METHODS.convertTaskToProject]: ConvertTaskParams,
  [METHODS.projectAction]: ProjectActionParams,
  [METHODS.resetMaintainer]: ResetMaintainerParams,
  [METHODS.taskAction]: TaskActionParams,
  [METHODS.taskBatchAction]: TaskBatchActionParams,
  [METHODS.retryVoice]: RetryVoiceParams,
  [METHODS.setToolkit]: SetToolkitParams,
  [METHODS.scheduledJobAction]: ScheduledJobActionParams,
  [METHODS.rescheduleJob]: RescheduleJobParams,
  [METHODS.runJobNow]: RunJobNowParams,
  [METHODS.setVoiceAnnounce]: SetVoiceAnnounceParams,
  [METHODS.createReminder]: CreateReminderParams,
} as const;

/** 每个方法的参数类型（由 PARAM_SCHEMAS 推出） */
export type MethodParams = { [M in Method]: Static<(typeof PARAM_SCHEMAS)[M]> };

/** 解析好的请求：method 决定 params 的类型；有副作用的方法幂等键必填 */
export type ParsedRequest = {
  [M in Method]: { id: string; method: M; params: MethodParams[M] } & (M extends IdempotentMethod ? { idempotencyKey: string } : { idempotencyKey?: string });
}[Method];

export type ParseRequestResult = { ok: true; request: ParsedRequest } | { ok: false; id: string | null; error: ErrorBody };

const frameValidator = Compile(RequestFrame);
const paramValidators = Object.fromEntries(Object.entries(PARAM_SCHEMAS).map(([method, schema]) => [method, Compile(schema)])) as {
  [M in Method]: ReturnType<typeof Compile<(typeof PARAM_SCHEMAS)[M]>>;
};
const channelValidator = Compile(Channel);

function isMethod(name: string): name is Method {
  return Object.hasOwn(PARAM_SCHEMAS, name);
}

/** 是不是一个频道名（按 schema 里的 Channel：全局频道，或者 `maintainer:<id>`） */
export function isChannel(name: string): boolean {
  return channelValidator.Check(name);
}

export function parseRequest(raw: string): ParseRequestResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail(null, "bad_frame", "不是合法的 JSON");
  }
  if (!frameValidator.Check(value)) {
    return fail(readId(value), "bad_frame", `请求帧格式不对：${describe(frameValidator.Errors(value))}`);
  }
  const { id, method, params, idempotencyKey } = value;
  if (!isMethod(method)) return fail(id, "unknown_method", `不认识的方法：${method}`);
  const validator = paramValidators[method];
  if (!validator.Check(params)) return fail(id, "bad_params", `${method} 的参数不对：${describe(validator.Errors(params))}`);
  if (idempotencyKey === undefined && requiresIdempotencyKey(method)) {
    return fail(id, "idempotency_key_required", `${method} 有副作用，请求必须带幂等键`);
  }
  // 上面按方法校验过参数、按需要查过幂等键，这里的组合和 ParsedRequest 的定义一致
  const request = { id, method, params, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } as ParsedRequest;
  return { ok: true, request };
}

function fail(id: string | null, code: ErrorBody["code"], message: string): ParseRequestResult {
  return { ok: false, id, error: { code, message } };
}

/** 帧不合格时尽量读出 id，好让前端把错误对上自己的请求 */
function readId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function describe(errors: readonly { instancePath: string; message: string }[]): string {
  const first = errors[0];
  if (!first) return "未知错误";
  return `${first.instancePath || "/"} ${first.message}`;
}
