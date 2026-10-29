// 语音插件（214 号票，ADR-0027；用户 2026-10-20："把内置浏览器和网页工具，日历和语音这三个拆成插件"）：语音消息的识别（31、180、208、
// 210 号票）、agent 用语音回复和发语音（32、38、86 号票）、模型预热（45 号票）、参考音色、Debug 工具集的语音组（124 号票）在守护进程这一侧的
// 全部登记都在这里，组合根只在插件清单里列它。开着时行为和搬过来之前一模一样（31 到 210 号票的规矩全照旧）。
// - 数据契约（停用也登记，不撤）：
//   - 用户的语音怎么变成素材、彻底删除时怎么改写语音事件（代码在内核的 voice-records/contract.ts：设置里成批删除时没有素材的语音由内核直接用）；
//   - 前端请求：发消息时收下语音 part（voiceIntake）、气泡菜单里的"重新识别"（retryVoice）——插件没启用时回"语音插件没启用"；
//   - 移除时"连数据删"（211 号票的口子，removal.ts）：录音、合成出的音频、语音事件里的文字（识别出的、送进 TTS 的）、参考音色、
//     待我处理里语音的两种说明；会话里转写成文字交给过二狗的那部分归会话，不删（确认框写明）。
//   语音对象的两个派生视图（voices、agent_voices）不在插件里声明：它们是内核的数据契约（voice-records/），停用时照样更新、彻底删除时照样重放，
//   历史里的语音气泡照样投影成文字、合成好的音频照样点得开（只是读文件）。
// - 装配：识别进程（放进它自己的 Job，环境照 agent 子进程的白名单；配置里 Python 还是占位的是"不可用"）、识别（voice.ts）、参考音色、
//   预热（warmup.ts，两个模型的状态变了推临时事件 voice_models）、语音回复和发语音（voice-reply.ts）、Debug 工具集的语音组；
//   提供服务 VOICE（api.ts）：内核经它把语音回复、输入队列的挡板接进每个会话（conversation/session-tools.ts），本机接口经它取设置 · 语音、
//   分段合成的段、Debug 的识别和合成，悬浮按钮上说话经它送识别。
// - start：识别接着上次没识别完的（排队、识别中的接着识别，等着自动重试的到点接着试）、语音回复接着没合成完的、开始预热；
//   stop：语音回复、预热、识别依次停下（识别进程结束）。
// - 运行中停用（211 号票，设置 · 插件）：识别进程停掉、合成不再调用；还没识别完的语音不再挡输入队列（内核的挡板 conversation/input-gate.ts：
//   只有语音的先不交，带附件、卡片的照交、语音那段是"识别失败"）；秘书手头这一条处理完按新的重新装配，没有口语总结、发语音工具；
//   正在跑的一轮里再调它们回"语音插件没启用"。启用回来是新的一次装配：排队、识别中的接着识别（同守护进程重启）。
// - agent 那一侧的工具（口语总结、发语音）不经 agent 贡献缝：它们是"每个会话都配的工具"（session-tools.ts），排在联网工具后面，
//   秘书、维护者的工具顺序和搬过来之前一样。系统提示里讲念语音的几句包在条件"语音"里（prompt.ts）。
import { type AgentVoiceEventPayload, CHANNELS, type ConversationId, EVENT_TYPES, forModel, PURGED_TEXT, t, type VoiceEventPayload } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { isPlaceholder } from "../config/config.ts";
import type { PluginDataRemoval } from "../plugins/removal.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { buildChildEnv } from "../process/child-env.ts";
import { createJobObject } from "../process/job-object.ts";
import { agentVoicesIn, voiceMaterialSource, voicePurge, voicesIn } from "../voice-records/index.ts";
import { agentIdOfConversation, voiceOfAgent } from "./agent-voice-ref.ts";
import { VOICE, type VoiceApi } from "./api.ts";
import { createDebugVoice } from "./debug-voice.ts";
import { voiceGateOf } from "./gate.ts";
import { RECOGNIZER_ENV, RECOGNIZER_SCRIPT, recognizerHint } from "./index.ts";
import { voicePrompts } from "./prompt.ts";
import { createHttpRecognizer } from "./recognizer-client.ts";
import { createProcessRecognizer, unavailableRecognizer } from "./recognizer.ts";
import { createFfmpegConverter } from "./audio-convert.ts";
import { openReferenceVoices } from "./reference-voices.ts";
import { createAudioCppSynthesizer } from "./speech.ts";
import { voiceToolOff } from "./texts.ts";
import { compileStripRules } from "./transcript-filter.ts";
import { createVoiceService } from "./voice.ts";
import { createVoiceReplies } from "./voice-reply.ts";
import { createVoiceWarmup } from "./warmup.ts";

/** 待我处理里属于语音的说明：识别进程不可用、还没有参考音色 */
const VOICE_NOTICES = ["voice_recognizer_unavailable", "voice_reference_missing"] as const;

/** 移除时"连数据删"（211 号票的口子；214 号票主会话定的第 4 条：录音、合成的音频文件、语音事件里的文字） */
const voiceRemoval: PluginDataRemoval = {
  get deletes() {
    return [t("voice.plugin.purge.recordings"), t("voice.plugin.purge.synthesized"), t("voice.plugin.purge.texts"), t("voice.plugin.purge.references"), t("voice.plugin.purge.notices")];
  },
  get keeps() {
    return [t("voice.plugin.keep.conversation"), t("voice.plugin.keep.materials"), t("voice.plugin.keep.backup")];
  },
  rewrite: [
    // 用户的语音：识别出的文字、分段的文字、识别失败的原因换成删除标记（彻底删除的改写函数 voicePurge，状态、时长这些不变）
    {
      type: EVENT_TYPES.voice,
      when: (event) => {
        const { voice } = event.payload as VoiceEventPayload;
        return (voice.recognition !== undefined && voice.recognition.text !== PURGED_TEXT) || (voice.error !== undefined && voice.error !== PURGED_TEXT);
      },
    },
    // agent 的语音：送进 TTS 的原文（"转文字"展开的那段）换成删除标记；这一轮回复的文字在会话的消息里，归会话，不动
    {
      type: EVENT_TYPES.agentVoice,
      when: (event) => {
        const { voice } = event.payload as AgentVoiceEventPayload;
        return voice.text !== undefined && voice.text !== PURGED_TEXT;
      },
      rewrite: (event) => {
        const payload = event.payload as AgentVoiceEventPayload;
        return { ...payload, voice: { ...payload.voice, text: PURGED_TEXT } } satisfies AgentVoiceEventPayload;
      },
    },
  ],
  notices: [...VOICE_NOTICES],
  // 参考音色（导入的录音和逐字稿）、分段合成的段（临时区）
  files: ["voices", "tmp/tts-segments"],
  // 录音（用户语音的音频）、合成出的音频（agent 语音拼好的完整音频）
  media: (store) => [
    ...voicesIn(store.reader).map((voice) => voice.mediaId),
    ...agentVoicesIn(store.reader).flatMap((voice) => (voice.mediaId === undefined ? [] : [voice.mediaId])),
  ],
};

export const voicePlugin: PluginDefinition = {
  name: "voice",
  get title() {
    return t("voice.plugin.title");
  },
  get summary() {
    return t("voice.plugin.summary");
  },
  get brings() {
    return { tools: [t("voice.tools.spokenSummary"), t("voice.tools.sendVoice")], cards: [], jobs: [] };
  },
  needs: [KERNEL.config, KERNEL.store, KERNEL.clock, KERNEL.inbox, KERNEL.media, KERNEL.layout, KERNEL.notifications, KERNEL.voiceEngines, KERNEL.agentRoles],
  provides: [VOICE],
  prompts: voicePrompts,
  contracts(ctx) {
    // 用户的语音（31）：识别完成时算用户发言，文字是识别出的文字（声明进内核的素材库：停用时照样留原话副本）
    ctx.materialSources.register(voiceMaterialSource);
    // 彻底删除：语音事件只去掉文字，连带改写消息、别的版本、重新识别成功后交给 agent 的通知
    ctx.purge.register(voicePurge);
    // 发消息时收下语音 part（31）、气泡菜单里的"重新识别"：插件没启用时回"语音插件没启用"
    ctx.requests.register("voiceIntake", { accept: (part, message) => ctx.active(VOICE).intake.accept(part, message) });
    ctx.requests.register("retryVoice", (params, idempotencyKey) => ctx.active(VOICE).retry(params, idempotencyKey));
    // 移除时连数据一起彻底删除（211 号票的口子）
    ctx.removal.declare(voiceRemoval);
  },
  setup(ctx) {
    const config = ctx.use(KERNEL.config);
    const store = ctx.use(KERNEL.store);
    const clock = ctx.use(KERNEL.clock);
    const inbox = ctx.use(KERNEL.inbox);
    const media = ctx.use(KERNEL.media);
    const layout = ctx.use(KERNEL.layout);
    const notifications = ctx.use(KERNEL.notifications);
    const engines = ctx.use(KERNEL.voiceEngines);
    const log = (line: string) => ctx.log(line);
    const voiceConfig = config.voice;
    const recognition = { language: voiceConfig.recognizer.language, initialPrompt: voiceConfig.recognizer.initialPrompt };

    // 语音消息（31）：识别按配置接一条（250 号票，两种接入并存）：默认 mode 是 spawn，守护进程自己拉起 Python 子进程
    // （放进它自己的 Job，环境照 agent 子进程的白名单；和 250 号票之前一模一样）；mode 是 lsm 时改调 LSM 托管的那条
    // 识别服务（deploy/lsm/ergo-asr.example.yaml），二狗不拉起、不结束它。两条是同一个接口（Recognizer），
    // 下面识别、预热、208 号票的健康检查、Debug 页、设置页都只认接口，一行都不用改。
    // 识别结果交出去之前剔掉模型自带的串词（180）：规则写错的这里跳过、写日志，不挡启动
    const recognizerConfig = voiceConfig.recognizer;
    const recognizerInit = { primary: recognizerConfig.primary, fallback: recognizerConfig.fallback };
    const stripRules = compileStripRules(recognizerConfig.stripPatterns, log);
    const recognizer =
      recognizerConfig.mode === "lsm"
        ? createHttpRecognizer({ url: recognizerConfig.url, init: recognizerInit, timeout: recognizerConfig.timeout, stripRules, log })
        : !engines.recognizerCommand && isPlaceholder(recognizerConfig.python)
          ? unavailableRecognizer(t("daemon.recognizerPlaceholder"))
          : createProcessRecognizer({
              command: engines.recognizerCommand ?? [recognizerConfig.python, RECOGNIZER_SCRIPT],
              env: buildChildEnv(engines.env, RECOGNIZER_ENV),
              cwd: layout.tmp,
              init: recognizerInit,
              idleMs: recognizerConfig.idleMs,
              timeout: recognizerConfig.timeout,
              newJob: () => (process.platform === "win32" ? createJobObject() : undefined),
              stripRules,
              log,
            });
    const voice = createVoiceService({
      store,
      media,
      inbox,
      recognizer,
      recognition,
      unavailableHint: () => recognizerHint(recognizerConfig.mode),
      // 识别没做成时隔一会儿自动重试（208）
      autoRetryMs: voiceConfig.recognizer.autoRetryMs,
      log,
    });
    // 参考音色（32）：数据目录 voices 区里的文件就是真相，设置里的语音页经 HTTP 导入、选用、删除。
    // 230 号票：导入的常见音频经本机 ffmpeg 转成 16 kHz 单声道 WAV（测试换成假的），逐字稿不给就用识别进程自动识别
    const referenceVoices = openReferenceVoices({
      dir: layout.voices,
      log,
      converter: createFfmpegConverter({ tmpDir: layout.tmp, ...(engines.ffmpegCommand === undefined ? {} : { command: engines.ffmpegCommand }), log }),
      recognizer,
      recognition,
    });
    // 模型预热（45）：在后台先加载识别模型、再用参考音色试合成一句让 audio.cpp 加载合成模型；不挡启动。
    // 两个模型的状态变了推一条临时事件（活动状态频道），本机接口 GET /api/voice-models 取得到同样的
    const warmup = createVoiceWarmup({
      recognizer,
      speech: createAudioCppSynthesizer({ ...voiceConfig.speech, url: engines.speechUrl ?? voiceConfig.speech.url, log }),
      references: referenceVoices,
      probeMs: voiceConfig.speech.probeMs,
      ...(engines.recognizerRetryMs === undefined ? {} : { retryMs: engines.recognizerRetryMs }),
      ...(engines.recognizerStableMs === undefined ? {} : { stableMs: engines.recognizerStableMs }),
      onChange: (payload) => notifications.publish({ channel: CHANNELS.activity, seq: store.lastSeq(CHANNELS.activity), type: EVENT_TYPES.voiceModels, payload }),
      log,
    });
    // 语音回复（32）：用户发语音时，agent 这一轮的回复经本机 LSM 托管的 audio.cpp 合成语音（二狗不启动它）；
    // 秘书和维护者各段的装配都多一个口语总结工具、发语音工具（86）（在它们拉起之前开始跟回合：插件比秘书、维护者先启动）。
    // 248 号票：说话的是哪个 agent 就用它那个角色指定的参考音色（没指定、被删了、插件没启用跟全局默认）
    const roles = ctx.use(KERNEL.agentRoles);
    const voiceOf = (conversation: ConversationId) => voiceOfAgent(agentIdOfConversation(conversation), { roles, voices: referenceVoices });
    const replies = createVoiceReplies({
      store,
      media,
      inbox,
      references: referenceVoices,
      voiceOf,
      // 试合成在做时，语音回复的合成等它做完再发
      speech: warmup.speech,
      pace: voiceConfig.reply,
      clock,
      tmpDir: layout.tmp,
      ...(engines.sendVoiceWaitMs === undefined ? {} : { sendVoiceWaitMs: engines.sendVoiceWaitMs }),
      log,
    });
    // Debug 工具集的语音组（124）：录一段送识别、用当前参考音色合成念一句，都不经会话
    const debug = createDebugVoice({ recognizer, recognition, speech: warmup.speech, references: referenceVoices, pace: voiceConfig.reply, tmpDir: layout.tmp, log });

    // 这一次装配停了以后（运行中停用），还没按新的装配重新拉起的 agent 在正在跑的一轮里再调口语总结、发语音：回"语音插件没启用"，不做
    let running = true;
    ctx.effect(() => () => {
      running = false;
    });
    const guarded = (tool: HostTool): HostTool => ({ ...tool, run: (args, call) => (running ? tool.run(args, call) : { text: voiceToolOff(forModel(() => t("voice.plugin.title")), tool.spec.name), isError: true }) });
    const tools = replies.tools.map(guarded);
    const api: VoiceApi = {
      intake: voice.intake,
      retry: (params, idempotencyKey) => voice.retry(params, idempotencyKey),
      gate: (message) => voiceGateOf(store.reader, message),
      replies: {
        tools,
        inputContext: (message) => replies.inputContext(message),
        followUp: (conversation, inputMessageId) => replies.followUp(conversation, inputMessageId),
        interruptedResults: (conversation) => replies.interruptedResults?.(conversation) ?? {},
      },
      referenceVoices,
      segmentFile: (voiceId, index) => replies.segmentFile(voiceId, index),
      models: () => warmup.view(),
      recognize: (audio, mime) => debug.recognize(audio, mime),
      speak: (text) => debug.speak(text),
      async whenIdle() {
        await voice.whenIdle();
        await replies.whenIdle();
      },
    };
    ctx.provide(VOICE, api);
    ctx.lifecycle({
      start() {
        // 上次没识别完的（守护进程停的时候、插件停用的时候在排队、在识别）接着识别；之后来一条识别一条
        voice.start();
        // 语音回复跟着会话频道上的回合走，上次没合成完的接着合成
        replies.start();
        warmup.start();
      },
      async stop() {
        await replies.stop();
        // 先于识别进程关掉（停的时候不再重拉）
        await warmup.stop();
        await voice.stop();
      },
    });
  },
};
