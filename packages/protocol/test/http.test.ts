// HTTP 接口的路径：怎么拼（HTTP_PATHS）和怎么拆（parseHttpPath）只写在协议包里，两边对得上。
import { describe, expect, it } from "vitest";
import { attachmentPartFrom, framePreviewOf, HTTP_PATHS, HTTP_QUERY, imagePartFrom, parseHttpPath, SERVICE_THUMBNAIL_REFRESH_MS, serviceThumbnailSeen, textPreviewOf } from "../src/index.ts";

const pathOf = (url: string) => new URL(url, "http://127.0.0.1:8810").pathname;
const queryOf = (url: string) => Object.fromEntries(new URL(url, "http://127.0.0.1:8810").searchParams);

describe("HTTP 接口的路径", () => {
  it("拼出来的路径拆得回去：接口和参数一样", () => {
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploads))).toEqual({ route: "uploads" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.upload("u-1")))).toEqual({ route: "upload", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploadChunk("u-1", 1024)))).toEqual({ route: "upload", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploadComplete("u-1")))).toEqual({ route: "upload_complete", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.media("a".repeat(64), { name: "报告 v2.pdf", download: true })))).toEqual({ route: "media", mediaId: "a".repeat(64) });
    // 文本类附件的内容（113 号票，报告页用）
    expect(parseHttpPath(pathOf(HTTP_PATHS.mediaText("a".repeat(64))))).toEqual({ route: "media_text", mediaId: "a".repeat(64) });
    // HTML、SVG 附件本身（117 号票，报告页的沙箱框、<img> 用）
    expect(parseHttpPath(pathOf(HTTP_PATHS.mediaHtml("a".repeat(64))))).toEqual({ route: "media_html", mediaId: "a".repeat(64) });
    expect(parseHttpPath(pathOf(HTTP_PATHS.mediaSvg("a".repeat(64))))).toEqual({ route: "media_svg", mediaId: "a".repeat(64) });
    expect(parseHttpPath(pathOf(HTTP_PATHS.history("maintainer:记忆系统", { before: 21 })))).toEqual({ route: "history", conversation: "maintainer:记忆系统" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.slashCommands("maintainer:pm-1")))).toEqual({ route: "slash_commands", conversation: "maintainer:pm-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.assistantName))).toEqual({ route: "assistant_name" });
    // 158 号票：设置里看素材（列表一页、一条的完整内容）；scope、delete、list 是保留的名字
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsScope))).toEqual({ route: "materials_scope" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsDelete))).toEqual({ route: "materials_delete" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsList))).toEqual({ route: "materials_list" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsWebPage))).toEqual({ route: "materials_web_page" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.material("mat-0123456789abcdef01234567")))).toEqual({ route: "material", materialId: "mat-0123456789abcdef01234567" });
    // 调用 id 什么字符都可能有（faux 的是 tool:<时间>:<随机串>）
    expect(parseHttpPath(pathOf(HTTP_PATHS.toolCall("tool:1730000000000:ab/c d?#")))).toEqual({ route: "tool_call", callId: "tool:1730000000000:ab/c d?#" });
    // 设置里的工具调用完整内容：占了多大、现在就清理（65 号票）
    expect(parseHttpPath(pathOf(HTTP_PATHS.toolCallStorage))).toEqual({ route: "tool_call_storage" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.toolCallStorageCleanup))).toEqual({ route: "tool_call_storage_cleanup" });
    // 设置里的"备份"：现在的状况、立即备份（335 号票）
    expect(parseHttpPath(pathOf(HTTP_PATHS.backup))).toEqual({ route: "backup" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.backupRun))).toEqual({ route: "backup_run" });
    expect(parseHttpPath("/api/backup/now")).toBeUndefined();
    expect(parseHttpPath("/api/backup/run/x")).toBeUndefined();
    // 设置里的"模型"：取、存，连通测试（73 号票）
    expect(parseHttpPath(pathOf(HTTP_PATHS.modelSettings))).toEqual({ route: "model_settings" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.modelSettingsTest))).toEqual({ route: "model_settings_test" });
    // 每个 agent 的 ⚙（114 号票）：面板、单独的提示词、清空、现在压缩
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentSettings("secretary")))).toEqual({ route: "agent_settings", agentId: "secretary" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentPrompt("tm-3")))).toEqual({ route: "agent_prompt", agentId: "tm-3" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentClear("pm-1")))).toEqual({ route: "agent_clear", agentId: "pm-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentCompact("pm-1")))).toEqual({ route: "agent_compact", agentId: "pm-1" });
    // 项目、任务的维护者单独配模型（120 号票）
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentModel("pm-1")))).toEqual({ route: "agent_model", agentId: "pm-1" });
    // Debug 工具集的语音组（124 号票）：录一段送识别、合成念一句
    expect(HTTP_PATHS.debugRecognize).toBe("/api/debug/recognize");
    expect(parseHttpPath(pathOf(HTTP_PATHS.debugRecognize))).toEqual({ route: "debug_recognize" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.debugSpeak))).toEqual({ route: "debug_speak" });
    // 项目的服务首页的缩略图（140 号票）：按项目编号和服务名
    expect(parseHttpPath(pathOf(HTTP_PATHS.serviceThumbnail("p-1", "site", { at: "2026-10-18T09:00:00.000+08:00", seen: "123" })))).toEqual({ route: "service_thumbnail", projectId: "p-1", name: "site" });
    // 项目规范的只读接口（258 号票）
    expect(HTTP_PATHS.projectStandard("p-1")).toBe("/api/projects/p-1/standard");
    expect(parseHttpPath(HTTP_PATHS.projectStandard("p-1"))).toEqual({ route: "project_standard", projectId: "p-1" });
    expect(parseHttpPath("/api/projects/p-1")).toBeUndefined();
    expect(parseHttpPath("/api/projects/p-1/other")).toBeUndefined();
    // 悬浮按钮上说的一段送识别（149 号票：一次性页面助手的 /api/page-command 和候选的 /pick 不再有）
    expect(HTTP_PATHS.pageVoice).toBe("/api/page-command/voice");
    expect(parseHttpPath(pathOf(HTTP_PATHS.pageVoice))).toEqual({ route: "page_voice" });
    expect(parseHttpPath("/api/page-command")).toBeUndefined();
    // 候选的缩略图（149 号票）
    expect(HTTP_PATHS.pageFileThumb("abc")).toBe("/api/page-files/abc/thumb");
    expect(parseHttpPath(pathOf(HTTP_PATHS.pageFileThumb("abc")))).toEqual({ route: "page_file_thumb", token: "abc" });
    // 记忆的推理库（233 号票，只读）：概览、结论列表、一条结论、问题箱
    expect(HTTP_PATHS.memorySummary).toBe("/api/memory/summary");
    expect(parseHttpPath(pathOf(HTTP_PATHS.memorySummary))).toEqual({ route: "memory_summary" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryClaims({ tier: "need", status: "active", limit: 50 })))).toEqual({ route: "memory_claims" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryClaims()))).toEqual({ route: "memory_claims" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryClaim("cl-0001")))).toEqual({ route: "memory_claim", claimId: "cl-0001" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryQuestions({ limit: 10 })))).toEqual({ route: "memory_questions" });
    // 330 号票：做法（交互策略）列表
    expect(HTTP_PATHS.memoryStrategies()).toBe("/api/memory/strategies");
    expect(parseHttpPath(HTTP_PATHS.memoryStrategies())).toEqual({ route: "memory_strategies" });
    // 记忆的设置（264 号票）：顺口问开不开
    expect(HTTP_PATHS.memorySettings).toBe("/api/memory/settings");
    expect(parseHttpPath(HTTP_PATHS.memorySettings)).toEqual({ route: "memory_settings" });
    expect(parseHttpPath("/api/memory/settings/more")).toBeUndefined();
    // 和素材那一套不撞：/api/memory/... 只认这五个
    expect(parseHttpPath("/api/memory")).toBeUndefined();
    expect(parseHttpPath("/api/memory/unknown")).toBeUndefined();
    expect(parseHttpPath("/api/memory/claims/cl-1/more")).toBeUndefined();
  });

  it("查询参数用 HTTP_QUERY 里的名字", () => {
    expect(queryOf(HTTP_PATHS.uploadChunk("u-1", 1024))).toEqual({ [HTTP_QUERY.offset]: "1024" });
    expect(queryOf(HTTP_PATHS.media("a".repeat(64), { name: "报告 v2.pdf", download: true }))).toEqual({ [HTTP_QUERY.name]: "报告 v2.pdf", [HTTP_QUERY.download]: "1" });
    expect(queryOf(HTTP_PATHS.media("a".repeat(64)))).toEqual({});
    expect(queryOf(HTTP_PATHS.history("secretary", { before: 21, limit: 5 }))).toEqual({ [HTTP_QUERY.before]: "21", [HTTP_QUERY.limit]: "5" });
    expect(queryOf(HTTP_PATHS.serviceThumbnail("p-1", "site", { at: "t", seen: "9" }))).toEqual({ [HTTP_QUERY.at]: "t", [HTTP_QUERY.seen]: "9" });
    expect(queryOf(HTTP_PATHS.serviceThumbnail("p-1", "site"))).toEqual({});
    // 记忆的推理库（233 号票）：结论列表的层、状态和条数，问题箱的条数
    expect(queryOf(HTTP_PATHS.memoryClaims({ tier: "need", status: "active", limit: 50 }))).toEqual({ [HTTP_QUERY.tier]: "need", [HTTP_QUERY.status]: "active", [HTTP_QUERY.limit]: "50" });
    expect(queryOf(HTTP_PATHS.memoryClaims())).toEqual({});
    expect(queryOf(HTTP_PATHS.memoryQuestions({ limit: 10 }))).toEqual({ [HTTP_QUERY.limit]: "10" });
  });

  it("不是 HTTP 接口的路径拆不出来", () => {
    for (const p of ["/", "/ws", "/healthz", "/api/", "/api/nope", "/api/uploads/", "/api/uploads/u/x", "/api/media", "/api/media/a/x", "/api/media/a/text/x", "/api/media/a/html/x", "/api/media/a/svg/x", "/api/media/a/xml", "/api/conversations/secretary", "/api/conversations/secretary/messages/1", "/api/uploads/%E0%A4%A", "/api/tool-calls", "/api/tool-calls/a/b", "/api/tool-call-storage/x", "/api/tool-call-storage/cleanup/x", "/api/model-settings/x", "/api/model-settings/test/x", "/api/agents", "/api/agents/secretary/x", "/api/agents/secretary/prompt/x", "/api/debug", "/api/debug/x", "/api/debug/speak/x", "/api/service-thumbnails", "/api/service-thumbnails/p-1", "/api/service-thumbnails/p-1/site/x"]) {
      expect({ path: p, route: parseHttpPath(p) }).toEqual({ path: p, route: undefined });
    }
  });
});

describe("服务首页缩略图地址里的 seen（140 号票）", () => {
  it("手里那张还够新不带；旧了（6 小时）、还没有的按第几个 6 小时给号，6 小时换一次", () => {
    const taken = Date.parse("2026-10-18T09:00:00.000+08:00");
    expect(serviceThumbnailSeen("2026-10-18T09:00:00.000+08:00", taken + SERVICE_THUMBNAIL_REFRESH_MS - 1)).toBeUndefined();
    const late = taken + SERVICE_THUMBNAIL_REFRESH_MS;
    expect(serviceThumbnailSeen("2026-10-18T09:00:00.000+08:00", late)).toBe(String(Math.floor(late / SERVICE_THUMBNAIL_REFRESH_MS)));
    expect(serviceThumbnailSeen(undefined, late)).toBe(serviceThumbnailSeen(undefined, late + 1));
    expect(serviceThumbnailSeen(undefined, late)).not.toBe(serviceThumbnailSeen(undefined, late + SERVICE_THUMBNAIL_REFRESH_MS));
  });
});

describe("拼附件 part", () => {
  it("图片 part：宽高有就带上，没有就不写", () => {
    expect(imagePartFrom({ mediaId: "m", name: "a.png", mime: "image/png", width: 3, height: 2 })).toEqual({ type: "image", mediaId: "m", name: "a.png", mime: "image/png", width: 3, height: 2 });
    expect(imagePartFrom({ mediaId: "m", name: "a.png", mime: "image/png", width: undefined })).toEqual({ type: "image", mediaId: "m", name: "a.png", mime: "image/png" });
  });

  it("入库后的媒体：服务端认出是图片的发图片 part，其余发文件 part", () => {
    expect(attachmentPartFrom({ mediaId: "m", kind: "image", name: "a.png", mime: "image/png", size: 9, width: 3, height: 2 })).toEqual({ type: "image", mediaId: "m", name: "a.png", mime: "image/png", width: 3, height: 2 });
    expect(attachmentPartFrom({ mediaId: "m", kind: "file", name: "a.heic", mime: "image/heic", size: 9 })).toEqual({ type: "file", mediaId: "m", name: "a.heic", mime: "image/heic", size: 9 });
  });
});

describe("能预览的文本类附件（113 号票）", () => {
  it("只看 part 上的类型：Markdown、纯文本能预览（按哪种渲染），别的类型只能下载", () => {
    expect(textPreviewOf({ name: "10 月 13 日日报.md", mime: "text/markdown" })).toBe("text/markdown");
    expect(textPreviewOf({ name: "运行日志.log", mime: "text/plain" })).toBe("text/plain");
    // 类型带参数、大小写不同也认
    expect(textPreviewOf({ name: "说明.txt", mime: "Text/Plain; charset=utf-8" })).toBe("text/plain");
    for (const mime of ["text/csv", "application/json", "application/pdf", "application/zip", "video/mp4", "image/png", "application/octet-stream", ""]) {
      expect({ mime, preview: textPreviewOf({ name: "附件", mime }) }).toEqual({ mime, preview: undefined });
    }
  });

  it("HTML、SVG 这类浏览器会当页面跑的：不论 part 上写的什么类型都不预览", () => {
    expect(textPreviewOf({ name: "活动页.html", mime: "text/html" })).toBeUndefined();
    expect(textPreviewOf({ name: "活动页.HTM", mime: "text/plain" })).toBeUndefined();
    expect(textPreviewOf({ name: "图标.svg", mime: "text/plain" })).toBeUndefined();
    expect(textPreviewOf({ name: "图标.svg", mime: "image/svg+xml" })).toBeUndefined();
  });
});

describe("在沙箱里预览的附件（117 号票）", () => {
  it("有扩展名的只看扩展名：html、htm 是 HTML，svg 是 SVG，part 上写的什么类型都一样（大小写不论）", () => {
    expect(framePreviewOf({ name: "AI 日报.html", mime: "text/html" })).toBe("html");
    expect(framePreviewOf({ name: "活动页.HTM", mime: "text/plain" })).toBe("html");
    expect(framePreviewOf({ name: "趋势图.svg", mime: "image/svg+xml" })).toBe("svg");
    expect(framePreviewOf({ name: "图标.SVG", mime: "application/octet-stream" })).toBe("svg");
  });

  it("xhtml、svgz、xml 和别的扩展名不预览：写成 text/html 也不算", () => {
    for (const name of ["页面.xhtml", "图标.svgz", "数据.xml", "日报.md", "说明.txt", "伪装.txt"]) {
      expect({ name, frame: framePreviewOf({ name, mime: "text/html" }) }).toEqual({ name, frame: undefined });
    }
  });

  it("没有扩展名的看 part 上的类型（带参数、大小写不同也认）", () => {
    expect(framePreviewOf({ name: "index", mime: "Text/HTML; charset=utf-8" })).toBe("html");
    expect(framePreviewOf({ name: "logo", mime: "image/svg+xml" })).toBe("svg");
    expect(framePreviewOf({ name: "附件", mime: "text/plain" })).toBeUndefined();
    expect(framePreviewOf({ name: "附件.", mime: "text/html" })).toBe("html");
  });

  it("按文本预览的判断不变：HTML、SVG 不按文本预览", () => {
    expect(textPreviewOf({ name: "AI 日报.html", mime: "text/html" })).toBeUndefined();
    expect(textPreviewOf({ name: "趋势图.svg", mime: "text/plain" })).toBeUndefined();
  });
});
