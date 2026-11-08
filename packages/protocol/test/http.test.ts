// HTTP 接口的路径：怎么拼（HTTP_PATHS）和怎么拆（parseHttpPath）只写在协议包里，两边对得上。
import { describe, expect, it } from "vitest";
import { attachmentPartFrom, framePreviewOf, HTTP_PATHS, HTTP_QUERY, imagePartFrom, mediaPreviewOf, parseHttpPath, pdfPreviewOf, SERVICE_THUMBNAIL_REFRESH_MS, serviceThumbnailSeen, textPreviewOf } from "../src/index.ts";

const pathOf = (url: string) => new URL(url, "http://127.0.0.1:8810").pathname;
const queryOf = (url: string) => Object.fromEntries(new URL(url, "http://127.0.0.1:8810").searchParams);

describe("HTTP 接口的路径", () => {
  it("拼出来的路径拆得回去：接口和参数一样", () => {
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploads))).toEqual({ route: "uploads" });
    // 手机 App 的更新：带着哪一版、安装包本身（.apk 结尾）
    expect(HTTP_PATHS.appUpdate).toBe("/api/app-update");
    expect(parseHttpPath(HTTP_PATHS.appUpdate)).toEqual({ route: "app_update" });
    expect(HTTP_PATHS.androidAppPackage).toBe("/api/app-update/android.apk");
    expect(parseHttpPath(HTTP_PATHS.androidAppPackage)).toEqual({ route: "android_app_package" });
    expect(parseHttpPath("/api/app-update/harmony.hap")).toBeUndefined();
    expect(parseHttpPath("/api/app-update/android.apk/x")).toBeUndefined();
    // 体检、体检页上"恢复提醒"（416）
    expect(parseHttpPath(HTTP_PATHS.doctor)).toEqual({ route: "doctor" });
    expect(HTTP_PATHS.doctorUnmute).toBe("/api/doctor/unmute");
    expect(parseHttpPath(HTTP_PATHS.doctorUnmute)).toEqual({ route: "doctor_unmute" });
    expect(parseHttpPath("/api/doctor/unmute/x")).toBeUndefined();
    expect(parseHttpPath("/api/doctor/x")).toBeUndefined();
    // 消耗页顶上的余额（440）：GET 取、POST 刷新同一个地址
    expect(HTTP_PATHS.usageBalance).toBe("/api/usage/balance");
    expect(parseHttpPath(HTTP_PATHS.usageBalance)).toEqual({ route: "usage_balance" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.usage({ from: "2026-11-01", to: "2026-11-08" })))).toEqual({ route: "usage" });
    expect(parseHttpPath("/api/usage/balance/x")).toBeUndefined();
    expect(parseHttpPath("/api/usage/x")).toBeUndefined();
    // 目录授权：全部、删一条、一次清掉几条、使用记录
    expect(parseHttpPath(pathOf(HTTP_PATHS.folderGrants))).toEqual({ route: "folder_grants" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.folderGrant("fg-1")))).toEqual({ route: "folder_grant", grantId: "fg-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.folderGrantsClear))).toEqual({ route: "folder_grants_clear" });
    expect(HTTP_PATHS.folderGrantUses({ limit: 20 })).toBe("/api/folder-grants/uses?limit=20");
    expect(parseHttpPath(pathOf(HTTP_PATHS.folderGrantUses({ limit: 20 })))).toEqual({ route: "folder_grant_uses" });
    expect(parseHttpPath("/api/folder-grants/fg-1/x")).toBeUndefined();
    expect(HTTP_PATHS.serviceEvents).toBe("/api/service-events");
    expect(parseHttpPath(pathOf(HTTP_PATHS.serviceEvents))).toEqual({ route: "service_events" });
    expect(parseHttpPath("/api/service-events/x")).toBeUndefined();
    expect(parseHttpPath(pathOf(HTTP_PATHS.upload("u-1")))).toEqual({ route: "upload", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploadChunk("u-1", 1024)))).toEqual({ route: "upload", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.uploadComplete("u-1")))).toEqual({ route: "upload_complete", uploadId: "u-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.media("a".repeat(64), { name: "报告 v2.pdf", download: true })))).toEqual({ route: "media", mediaId: "a".repeat(64) });
    // 文本类附件的内容（报告页用）
    expect(parseHttpPath(pathOf(HTTP_PATHS.mediaText("a".repeat(64))))).toEqual({ route: "media_text", mediaId: "a".repeat(64) });
    // HTML、SVG 附件本身（报告页的沙箱框、<img> 用）
    expect(parseHttpPath(pathOf(HTTP_PATHS.mediaHtml("a".repeat(64))))).toEqual({ route: "media_html", mediaId: "a".repeat(64) });
    expect(parseHttpPath(pathOf(HTTP_PATHS.mediaSvg("a".repeat(64))))).toEqual({ route: "media_svg", mediaId: "a".repeat(64) });
    expect(parseHttpPath(pathOf(HTTP_PATHS.history("maintainer:记忆系统", { before: 21 })))).toEqual({ route: "history", conversation: "maintainer:记忆系统" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.slashCommands("maintainer:pm-1")))).toEqual({ route: "slash_commands", conversation: "maintainer:pm-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.assistantName))).toEqual({ route: "assistant_name" });
    // 设置里看素材（列表一页、一条的完整内容）；scope、delete、list 是保留的名字
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsScope))).toEqual({ route: "materials_scope" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsDelete))).toEqual({ route: "materials_delete" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsList))).toEqual({ route: "materials_list" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.materialsWebPage))).toEqual({ route: "materials_web_page" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.material("mat-0123456789abcdef01234567")))).toEqual({ route: "material", materialId: "mat-0123456789abcdef01234567" });
    // 调用 id 什么字符都可能有（faux 的是 tool:<时间>:<随机串>）
    expect(parseHttpPath(pathOf(HTTP_PATHS.toolCall("tool:1730000000000:ab/c d?#")))).toEqual({ route: "tool_call", callId: "tool:1730000000000:ab/c d?#" });
    // 设置里的工具调用完整内容：占了多大、现在就清理
    expect(parseHttpPath(pathOf(HTTP_PATHS.toolCallStorage))).toEqual({ route: "tool_call_storage" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.toolCallStorageCleanup))).toEqual({ route: "tool_call_storage_cleanup" });
    // 设置里的"备份"：现在的状况、立即备份
    expect(parseHttpPath(pathOf(HTTP_PATHS.backup))).toEqual({ route: "backup" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.backupRun))).toEqual({ route: "backup_run" });
    // 备份单独一页的几个接口
    expect(parseHttpPath(pathOf(HTTP_PATHS.backupConfig))).toEqual({ route: "backup_config" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.backupCheckFolder))).toEqual({ route: "backup_check_folder" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.backupSnapshots))).toEqual({ route: "backup_snapshots" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.backupVerify))).toEqual({ route: "backup_verify" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.backupOpen))).toEqual({ route: "backup_open" });
    expect(parseHttpPath("/api/backup/now")).toBeUndefined();
    expect(parseHttpPath("/api/backup/run/x")).toBeUndefined();
    // 设置里的"模型"：取、存，连通测试
    expect(parseHttpPath(pathOf(HTTP_PATHS.modelSettings))).toEqual({ route: "model_settings" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.modelSettingsTest))).toEqual({ route: "model_settings_test" });
    // 每个 agent 的 ⚙：面板、单独的提示词、清空、现在压缩
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentSettings("secretary")))).toEqual({ route: "agent_settings", agentId: "secretary" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentPrompt("tm-3")))).toEqual({ route: "agent_prompt", agentId: "tm-3" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentClear("pm-1")))).toEqual({ route: "agent_clear", agentId: "pm-1" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentCompact("pm-1")))).toEqual({ route: "agent_compact", agentId: "pm-1" });
    // 项目、任务的负责人单独配模型
    expect(parseHttpPath(pathOf(HTTP_PATHS.agentModel("pm-1")))).toEqual({ route: "agent_model", agentId: "pm-1" });
    // Debug 工具集的语音组：录一段送识别、合成念一句
    expect(HTTP_PATHS.debugRecognize).toBe("/api/debug/recognize");
    expect(parseHttpPath(pathOf(HTTP_PATHS.debugRecognize))).toEqual({ route: "debug_recognize" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.debugSpeak))).toEqual({ route: "debug_speak" });
    // 项目的服务首页的缩略图：按项目编号和服务名
    expect(parseHttpPath(pathOf(HTTP_PATHS.serviceThumbnail("p-1", "site", { at: "2026-10-18T09:00:00.000+08:00", seen: "123" })))).toEqual({ route: "service_thumbnail", projectId: "p-1", name: "site" });
    // 项目规范的只读接口
    expect(HTTP_PATHS.projectStandard("p-1")).toBe("/api/projects/p-1/standard");
    expect(parseHttpPath(HTTP_PATHS.projectStandard("p-1"))).toEqual({ route: "project_standard", projectId: "p-1" });
    expect(parseHttpPath("/api/projects/p-1")).toBeUndefined();
    expect(parseHttpPath("/api/projects/p-1/other")).toBeUndefined();
    // 悬浮按钮上说的一段送识别（一次性页面助手的 /api/page-command 和候选的 /pick 不再有）
    expect(HTTP_PATHS.pageVoice).toBe("/api/page-command/voice");
    expect(parseHttpPath(pathOf(HTTP_PATHS.pageVoice))).toEqual({ route: "page_voice" });
    expect(parseHttpPath("/api/page-command")).toBeUndefined();
    // 候选的缩略图
    expect(HTTP_PATHS.pageFileThumb("abc")).toBe("/api/page-files/abc/thumb");
    expect(parseHttpPath(pathOf(HTTP_PATHS.pageFileThumb("abc")))).toEqual({ route: "page_file_thumb", token: "abc" });
    // 记忆的推理库（只读）：概览、结论列表、一条结论、问题箱
    expect(HTTP_PATHS.memorySummary).toBe("/api/memory/summary");
    expect(parseHttpPath(pathOf(HTTP_PATHS.memorySummary))).toEqual({ route: "memory_summary" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryClaims({ tier: "need", status: "active", limit: 50 })))).toEqual({ route: "memory_claims" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryClaims()))).toEqual({ route: "memory_claims" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryClaim("cl-0001")))).toEqual({ route: "memory_claim", claimId: "cl-0001" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.memoryQuestions({ limit: 10 })))).toEqual({ route: "memory_questions" });
    // 做法（交互策略）列表
    expect(HTTP_PATHS.memoryStrategies()).toBe("/api/memory/strategies");
    expect(parseHttpPath(HTTP_PATHS.memoryStrategies())).toEqual({ route: "memory_strategies" });
    // 记忆的设置：顺口问开不开
    expect(HTTP_PATHS.memorySettings).toBe("/api/memory/settings");
    expect(parseHttpPath(HTTP_PATHS.memorySettings)).toEqual({ route: "memory_settings" });
    expect(parseHttpPath("/api/memory/settings/more")).toBeUndefined();
    // 和素材那一套不撞：/api/memory/... 只认这五个
    expect(parseHttpPath("/api/memory")).toBeUndefined();
    expect(parseHttpPath("/api/memory/unknown")).toBeUndefined();
    expect(parseHttpPath("/api/memory/claims/cl-1/more")).toBeUndefined();
    // 设置 · 服务（428）：列表、一个服务的操作（名下的服务全名带 --）、它的日志
    expect(HTTP_PATHS.managedServices).toBe("/api/managed-services");
    expect(parseHttpPath(HTTP_PATHS.managedServices)).toEqual({ route: "managed_services" });
    expect(parseHttpPath(HTTP_PATHS.managedService("ergo-daemon--audiocpp"))).toEqual({ route: "managed_service", id: "ergo-daemon--audiocpp" });
    expect(parseHttpPath(pathOf(HTTP_PATHS.managedServiceLogs("ergo-asr", { lines: 60 })))).toEqual({ route: "managed_service_logs", id: "ergo-asr" });
    expect(parseHttpPath("/api/managed-services/x/y")).toBeUndefined();
    expect(parseHttpPath("/api/managed-services/x/logs/y")).toBeUndefined();
  });

  it("查询参数用 HTTP_QUERY 里的名字", () => {
    expect(queryOf(HTTP_PATHS.uploadChunk("u-1", 1024))).toEqual({ [HTTP_QUERY.offset]: "1024" });
    expect(queryOf(HTTP_PATHS.media("a".repeat(64), { name: "报告 v2.pdf", download: true }))).toEqual({ [HTTP_QUERY.name]: "报告 v2.pdf", [HTTP_QUERY.download]: "1" });
    expect(queryOf(HTTP_PATHS.media("a".repeat(64)))).toEqual({});
    expect(queryOf(HTTP_PATHS.history("secretary", { before: 21, limit: 5 }))).toEqual({ [HTTP_QUERY.before]: "21", [HTTP_QUERY.limit]: "5" });
    expect(queryOf(HTTP_PATHS.serviceThumbnail("p-1", "site", { at: "t", seen: "9" }))).toEqual({ [HTTP_QUERY.at]: "t", [HTTP_QUERY.seen]: "9" });
    expect(queryOf(HTTP_PATHS.serviceThumbnail("p-1", "site"))).toEqual({});
    // 记忆的推理库：结论列表的层、状态和条数，问题箱的条数
    expect(queryOf(HTTP_PATHS.memoryClaims({ tier: "need", status: "active", limit: 50 }))).toEqual({ [HTTP_QUERY.tier]: "need", [HTTP_QUERY.status]: "active", [HTTP_QUERY.limit]: "50" });
    expect(queryOf(HTTP_PATHS.memoryClaims())).toEqual({});
    expect(queryOf(HTTP_PATHS.memoryQuestions({ limit: 10 }))).toEqual({ [HTTP_QUERY.limit]: "10" });
    expect(queryOf(HTTP_PATHS.managedServiceLogs("tts", { lines: 60, source: 1 }))).toEqual({ [HTTP_QUERY.lines]: "60", [HTTP_QUERY.source]: "1" });
    expect(queryOf(HTTP_PATHS.managedServiceLogs("tts"))).toEqual({});
  });

  it("不是 HTTP 接口的路径拆不出来", () => {
    for (const p of ["/", "/ws", "/healthz", "/api/", "/api/nope", "/api/uploads/", "/api/uploads/u/x", "/api/media", "/api/media/a/x", "/api/media/a/text/x", "/api/media/a/html/x", "/api/media/a/svg/x", "/api/media/a/xml", "/api/conversations/secretary", "/api/conversations/secretary/messages/1", "/api/uploads/%E0%A4%A", "/api/tool-calls", "/api/tool-calls/a/b", "/api/tool-call-storage/x", "/api/tool-call-storage/cleanup/x", "/api/model-settings/x", "/api/model-settings/test/x", "/api/agents", "/api/agents/secretary/x", "/api/agents/secretary/prompt/x", "/api/debug", "/api/debug/x", "/api/debug/speak/x", "/api/service-thumbnails", "/api/service-thumbnails/p-1", "/api/service-thumbnails/p-1/site/x"]) {
      expect({ path: p, route: parseHttpPath(p) }).toEqual({ path: p, route: undefined });
    }
  });
});

describe("服务首页缩略图地址里的 seen", () => {
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

describe("能预览的文本类附件", () => {
  it("扩展名在清单里的按扩展名画：Markdown、纯文本、JSON、CSV / TSV 表格、代码和配置；part 上写的什么类型都一样", () => {
    for (const [name, mime, kind] of [
      ["10 月 13 日日报.md", "text/markdown", "markdown"],
      ["运行日志.log", "text/plain", "plain"],
      ["报销明细.csv", "text/csv", "csv"],
      // Windows 上浏览器常把 .csv 报成 Excel 的类型
      ["报销明细.CSV", "application/vnd.ms-excel", "csv"],
      ["导出.tsv", "text/tab-separated-values", "tsv"],
      ["配置.json", "application/json", "json"],
      ["日志.jsonl", "application/x-ndjson", "code"],
      ["脚本.py", "text/x-python", "code"],
      ["论文.tex", "application/x-tex", "code"],
      ["部署.yaml", "application/yaml", "code"],
      ["设置.ini", "text/plain", "code"],
      ["组件.vue", "application/octet-stream", "code"],
    ] as const) {
      expect({ name, kind: textPreviewOf({ name, mime }) }).toEqual({ name, kind });
    }
  });

  it("没有扩展名、扩展名不认得的看 part 上的类型（带参数、大小写不同也认）；不是文本的只能下载", () => {
    expect(textPreviewOf({ name: "说明", mime: "Text/Plain; charset=utf-8" })).toBe("plain");
    expect(textPreviewOf({ name: "附件", mime: "text/markdown" })).toBe("markdown");
    expect(textPreviewOf({ name: "附件", mime: "text/csv" })).toBe("csv");
    expect(textPreviewOf({ name: "附件", mime: "application/json" })).toBe("json");
    expect(textPreviewOf({ name: "备份.dat", mime: "text/plain" })).toBe("plain");
    for (const mime of ["application/pdf", "application/zip", "video/mp4", "audio/mpeg", "image/png", "application/octet-stream", ""]) {
      expect({ mime, preview: textPreviewOf({ name: "附件", mime }) }).toEqual({ mime, preview: undefined });
    }
    for (const name of ["合同.docx", "预算.xlsx", "资料.zip", "周会.mp4", "发票.pdf"]) {
      expect({ name, preview: textPreviewOf({ name, mime: "application/octet-stream" }) }).toEqual({ name, preview: undefined });
    }
    // 对象自带的名字不算清单里的扩展名
    expect(textPreviewOf({ name: "奇怪.constructor", mime: "application/octet-stream" })).toBeUndefined();
  });

  it("HTML、SVG 这类浏览器会当页面跑的：不论 part 上写的什么类型都不预览", () => {
    expect(textPreviewOf({ name: "活动页.html", mime: "text/html" })).toBeUndefined();
    expect(textPreviewOf({ name: "活动页.HTM", mime: "text/plain" })).toBeUndefined();
    expect(textPreviewOf({ name: "图标.svg", mime: "text/plain" })).toBeUndefined();
    expect(textPreviewOf({ name: "图标.svg", mime: "image/svg+xml" })).toBeUndefined();
    for (const name of ["页面.xhtml", "数据.xml", "订阅.rss", "存档.mht"]) {
      expect({ name, preview: textPreviewOf({ name, mime: "text/plain" }) }).toEqual({ name, preview: undefined });
    }
  });
});

describe("能在报告页播放的音频、视频附件", () => {
  it("有扩展名的看扩展名：mp3、m4a、aac、wav、flac、ogg、opus 是音频，mp4、m4v、mov、mkv 是视频（大小写不论）", () => {
    for (const name of ["录音.mp3", "语音备忘.M4A", "片段.aac", "采样.wav", "无损.flac", "播客.ogg", "语音.opus"]) {
      expect({ name, media: mediaPreviewOf({ name, mime: "application/octet-stream" }) }).toEqual({ name, media: "audio" });
    }
    for (const name of ["周会.mp4", "片头.m4v", "手机拍的.MOV", "电影.mkv"]) {
      expect({ name, media: mediaPreviewOf({ name, mime: "application/octet-stream" }) }).toEqual({ name, media: "video" });
    }
  });

  it(".webm 看 part 上的类型：audio/* 是音频，别的是视频", () => {
    expect(mediaPreviewOf({ name: "录音.webm", mime: "audio/webm" })).toBe("audio");
    expect(mediaPreviewOf({ name: "录屏.webm", mime: "video/webm" })).toBe("video");
    expect(mediaPreviewOf({ name: "录屏.webm", mime: "" })).toBe("video");
  });

  it("浏览器放不了的（avi、wmv）、别的扩展名只能下载，part 上写成音视频也一样；没有扩展名的看 part 上的类型", () => {
    for (const name of ["老录像.avi", "旧视频.wmv", "伪装.txt", "资料.zip"]) {
      expect({ name, media: mediaPreviewOf({ name, mime: "video/mp4" }) }).toEqual({ name, media: undefined });
    }
    expect(mediaPreviewOf({ name: "录音", mime: "audio/webm" })).toBe("audio");
    expect(mediaPreviewOf({ name: "录像", mime: "Video/MP4" })).toBe("video");
    expect(mediaPreviewOf({ name: "附件", mime: "text/plain" })).toBeUndefined();
  });
});

describe("在报告页用 pdf.js 画的 PDF 附件", () => {
  it("有扩展名的只看扩展名（.pdf，大小写不论）：part 上写的什么类型都一样；别的扩展名写成 application/pdf 也不算", () => {
    expect(pdfPreviewOf({ name: "周会纪要.pdf", mime: "application/pdf" })).toBe(true);
    expect(pdfPreviewOf({ name: "扫描件.PDF", mime: "application/octet-stream" })).toBe(true);
    for (const name of ["合同.docx", "图.png", "说明.txt", "pdf"]) expect({ name, pdf: pdfPreviewOf({ name, mime: "application/pdf" }) }).toEqual({ name, pdf: name === "pdf" });
  });

  it("没有扩展名的看 part 上的类型（带参数、大小写不同也认）；PDF 不按文本、音视频、沙箱预览", () => {
    expect(pdfPreviewOf({ name: "合同", mime: "Application/PDF; name=a" })).toBe(true);
    expect(pdfPreviewOf({ name: "合同", mime: "application/octet-stream" })).toBe(false);
    const part = { name: "周会纪要.pdf", mime: "application/pdf" };
    expect([textPreviewOf(part), mediaPreviewOf(part), framePreviewOf(part)]).toEqual([undefined, undefined, undefined]);
  });
});

describe("在沙箱里预览的附件", () => {
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
