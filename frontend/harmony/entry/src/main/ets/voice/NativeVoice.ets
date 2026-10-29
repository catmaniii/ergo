import { audio } from '@kit.AudioKit';
import { abilityAccessCtrl, bundleManager, common, Permissions } from '@kit.AbilityKit';
import { BusinessError, systemDateTime } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';

const MICROPHONE: Permissions = 'ohos.permission.MICROPHONE';

/** 录音的格式：16 kHz、单声道、16 位小端 PCM（语音识别够用，faster-whisper 内部也按 16 kHz；60 秒不到 2 MB） */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
/** 录着的时候多久往网页推一次音量（毫秒） */
const LEVEL_INTERVAL_MS = 50;
/** 一段最多留多少字节：网页 60 秒自动发送，多留 10 秒余量，超出的丢掉 */
const MAX_TAKE_BYTES = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * 70;

/** 备好的结果（网页的 packages/web/src/app/native-voice.ts 解析） */
interface PrepareReply {
  ok: boolean;
  id?: number;
  prepareMs?: number;
  state?: string;
  reason?: string;
  message?: string;
}

/** 开始的结果 */
interface StartReply {
  ok: boolean;
  id?: number;
  reason?: string;
  message?: string;
}

/** 停下交出的一段：PCM 的 base64 和格式；firstDataMs 是 start 调进来到第一块数据的毫秒数 */
interface StopReply {
  ok: boolean;
  id?: number;
  pcm?: string;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  firstDataMs?: number;
  reason?: string;
  message?: string;
}

/** 往网页推的：level 实时音量（均方根 0–1）、error 录音器出错或被系统打断、released App 自己放掉了录音器 */
interface VoiceEvent {
  type: string;
  id: number;
  rms?: number;
  reason?: string;
  message?: string;
}

/** 要权限的结果 */
interface PermissionResult {
  granted: boolean;
  /** 没给：用户拒了（denied）还是出错了（failed） */
  reason: string;
  message: string;
}

/** 单调时钟（开机到现在的毫秒数），量耗时用；取不到时退回 Date.now()（只用来算差值） */
function uptime(): number {
  try {
    return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'getUptime failed: %{public}s', JSON.stringify(e));
    return Date.now();
  }
}

function errorText(err: BusinessError): string {
  return typeof err.code === 'number' ? t('harmony.common.errorWithCode', { 'message': `${err.message}`, 'code': String(err.code) }) : `${err.message}`;
}

function permission(granted: boolean, reason: string, message: string): PermissionResult {
  const result: PermissionResult = { granted: granted, reason: reason, message: message };
  return result;
}

function stateName(state: audio.AudioState): string {
  switch (state) {
    case audio.AudioState.STATE_NEW:
      return 'NEW';
    case audio.AudioState.STATE_PREPARED:
      return 'PREPARED';
    case audio.AudioState.STATE_RUNNING:
      return 'RUNNING';
    case audio.AudioState.STATE_STOPPED:
      return 'STOPPED';
    case audio.AudioState.STATE_RELEASED:
      return 'RELEASED';
    case audio.AudioState.STATE_PAUSED:
      return 'PAUSED';
    default:
      return `STATE_${state}`;
  }
}

function failure(reason: string, message: string): string {
  const reply: PrepareReply = { ok: false, reason: reason, message: message };
  return JSON.stringify(reply);
}

/**
 * 原生录音（63 号票，用户 2026-10-09 要求：用系统自带的录音能力解决麦克风的问题，"准备好但不使用"）。
 * 照鸿蒙官方的 AudioCapturer 用法：
 * - prepare：进语音模式时网页要，createAudioCapturer 建好录音器，它就处在 PREPARED：不采集；录音的音频焦点在 start 时才申请
 *   （官方"音频焦点"：开始录制时系统才为音频流申请焦点），所以不占麦克风、不挡系统输入法的语音、隐私指示灯不亮。
 *   App 还没有麦克风权限就先向用户要；用户拒过的系统不再弹框，按下时（userAction）弹"去设置里打开"的框；
 * - start：按下时 start()，readData 收 PCM，每 50 毫秒往网页推一次音量；回调在留下录音器之前挂好，挂不上就放掉、回备不好；
 * - stop：松手 stop()（录音器回到 STOPPED，下次还能直接 start，同样不占焦点），把这一段 PCM 用 base64 交给网页，网页加 WAV 头上传；
 * - discard：丢掉这一段；release：离开语音模式、切到后台、页面重新加载时放掉录音器（release()）。
 * 录音器上的操作（建、开始、停、放）都是异步的，排成一队一个一个做；每放掉一次 generation 加一，还没建好的那次建好后马上放掉。
 * 录着的时候被系统打断（来电、别的应用要麦克风）：放掉录音器，告诉网页（error），网页提示、下次按下再备好。
 * 音源用 SOURCE_TYPE_MIC（理由见 docs/developer-guide.md"鸿蒙 App"一节的原生录音）；ArkTS 的 AudioCapturer 没有低时延模式（capturerFlags 只能是 0，
 * 低时延通路只在 C 接口 OHAudio 里），用的是普通通路。
 */
export class NativeVoice {
  private context: common.UIAbilityContext;
  /** 往网页推（Index.ets 用 controller.runJavaScript 调 window.__ergoVoice） */
  private emit: (json: string) => void;
  private capturer: audio.AudioCapturer | undefined = undefined;
  /** 现在这个录音器的编号（网页据此丢掉旧录音器的消息） */
  private capturerId: number = 0;
  /** 每放掉一次加一：还在排队、还在建的 prepare 据此作废 */
  private generation: number = 0;
  /** 录音器上的操作一个一个做 */
  private queue: Promise<void> = Promise.resolve();
  /** 在收这一段的数据 */
  private recording: boolean = false;
  private chunks: ArrayBuffer[] = [];
  private bytes: number = 0;
  /** 网页调 start 的那一刻、第一块数据到的那一刻（单调时钟） */
  private startCalledAt: number = 0;
  private firstDataAt: number = 0;
  /** 音量：上次推的时刻，之后累计的平方和、样本数 */
  private lastLevelAt: number = 0;
  private sumSquares: number = 0;
  private sampleCount: number = 0;

  constructor(context: common.UIAbilityContext, emit: (json: string) => void) {
    this.context = context;
    this.emit = emit;
  }

  /** 备好录音器（PREPARED，不采集）；已经备好就沿用。回 JSON：{ ok, id, prepareMs, state } 或 { ok: false, reason, message } */
  prepare(userAction: boolean): Promise<string> {
    const ticket = this.generation;
    return this.enqueue<string>(async (): Promise<string> => {
      if (ticket !== this.generation) {
        return failure('cancelled', t('harmony.voice.releasedEarly'));
      }
      const existing = this.capturer;
      if (existing !== undefined) {
        const reused: PrepareReply = { ok: true, id: this.capturerId, prepareMs: 0, state: stateName(existing.state) };
        return JSON.stringify(reused);
      }
      const access = await this.ensurePermission(userAction);
      if (!access.granted) {
        return failure(access.reason, access.message);
      }
      if (ticket !== this.generation) {
        return failure('cancelled', t('harmony.voice.releasedEarly'));
      }
      const begin = uptime();
      let capturer: audio.AudioCapturer | undefined = undefined;
      try {
        capturer = await audio.createAudioCapturer(this.options());
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'createAudioCapturer failed: %{public}s', JSON.stringify(e));
        return failure('failed', t('harmony.voice.createFailedWith', { 'error': errorText(e as BusinessError) }));
      }
      if (capturer === undefined) {
        return failure('failed', t('harmony.voice.createFailed'));
      }
      const prepareMs = uptime() - begin;
      if (ticket !== this.generation) {
        // 建的时候网页（或 App）已经放掉了：建好的马上放掉
        await this.releaseCapturer(capturer);
        return failure('cancelled', t('harmony.voice.releasedEarly'));
      }
      // 先挂回调再留下它：挂不上的录音器录不到东西，放掉、不留，告诉网页备不好
      const id = this.capturerId + 1;
      const broken = this.listen(capturer, id);
      if (broken.length > 0) {
        await this.releaseCapturer(capturer);
        return failure('failed', t('harmony.voice.listenFailed', { 'error': broken }));
      }
      this.capturerId = id;
      this.capturer = capturer;
      hilog.info(DOMAIN, TAG, 'voice capturer %{public}d prepared in %{public}d ms, state %{public}s', id, prepareMs, stateName(capturer.state));
      const reply: PrepareReply = { ok: true, id: id, prepareMs: prepareMs, state: stateName(capturer.state) };
      return JSON.stringify(reply);
    });
  }

  /** 开始采集（按下）。回 JSON：{ ok, id } 或 { ok: false, reason, message } */
  start(): Promise<string> {
    const calledAt = uptime();
    return this.enqueue<string>(async (): Promise<string> => {
      const capturer = this.capturer;
      if (capturer === undefined) {
        return failure('failed', t('harmony.voice.notPrepared'));
      }
      const id = this.capturerId;
      this.resetTake();
      this.startCalledAt = calledAt;
      this.recording = true;
      try {
        await capturer.start();
      } catch (e) {
        this.recording = false;
        this.resetTake();
        hilog.error(DOMAIN, TAG, 'capturer start failed: %{public}s', JSON.stringify(e));
        return failure('failed', t('harmony.voice.startFailed', { 'error': errorText(e as BusinessError) }));
      }
      const reply: StartReply = { ok: true, id: id };
      return JSON.stringify(reply);
    });
  }

  /** 停下（松手），交出这一段；录音器回到 STOPPED，留给下一条。回 JSON：{ ok, id, pcm, sampleRate, channels, bitsPerSample, firstDataMs } */
  stop(): Promise<string> {
    return this.enqueue<string>(async (): Promise<string> => {
      const capturer = this.capturer;
      if (capturer === undefined || !this.recording) {
        return failure('failed', t('harmony.voice.notRecording'));
      }
      const id = this.capturerId;
      try {
        await capturer.stop();
      } catch (e) {
        // 停不下来也把已经收到的交出去
        hilog.error(DOMAIN, TAG, 'capturer stop failed: %{public}s', JSON.stringify(e));
      }
      this.recording = false;
      const pcm = this.takeBytes();
      const firstDataAt = this.firstDataAt;
      const startCalledAt = this.startCalledAt;
      this.resetTake();
      let base64 = '';
      try {
        base64 = new util.Base64Helper().encodeToStringSync(pcm);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'encode take failed: %{public}s', JSON.stringify(e));
        return failure('failed', t('harmony.voice.encodeFailed', { 'error': errorText(e as BusinessError) }));
      }
      const reply: StopReply = {
        ok: true,
        id: id,
        pcm: base64,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        bitsPerSample: BITS_PER_SAMPLE
      };
      if (firstDataAt > 0) {
        reply.firstDataMs = firstDataAt - startCalledAt;
      }
      hilog.info(DOMAIN, TAG, 'voice take: %{public}d bytes, first data after %{public}d ms', pcm.length, reply.firstDataMs ?? -1);
      return JSON.stringify(reply);
    });
  }

  /** 丢掉这一段（上划取消、太短、出错）：停下、扔掉；录音器留着 */
  discard(): void {
    this.enqueue<void>(async (): Promise<void> => {
      const capturer = this.capturer;
      if (capturer === undefined || !this.recording) {
        return;
      }
      this.recording = false;
      this.resetTake();
      try {
        await capturer.stop();
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'capturer stop (discard) failed: %{public}s', JSON.stringify(e));
      }
    });
  }

  /** 放掉录音器（网页要的：离开语音模式、切到后台）；还在建的那次建好后马上放掉 */
  release(): void {
    this.generation += 1;
    this.recording = false;
    this.resetTake();
    const capturer = this.capturer;
    this.capturer = undefined;
    if (capturer === undefined) {
      return;
    }
    this.enqueue<void>(async (): Promise<void> => {
      await this.releaseCapturer(capturer);
    });
  }

  /** App 自己放掉录音器（切到后台、页面重新加载、换地址）：放掉，并告诉网页（released） */
  releaseByApp(reason: string): void {
    const had = this.capturer !== undefined;
    const id = this.capturerId;
    this.release();
    if (had) {
      const event: VoiceEvent = { type: 'released', id: id, reason: reason };
      this.push(event);
    }
  }

  private options(): audio.AudioCapturerOptions {
    const streamInfo: audio.AudioStreamInfo = {
      samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
      channels: audio.AudioChannel.CHANNEL_1,
      sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
      encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
    };
    // SOURCE_TYPE_MIC：按系统的录音焦点表，二狗录着时输入法常用的 VOICE_RECOGNITION 能并存（反过来也是）；不像 VOICE_COMMUNICATION
    // 那样开 3A、挡掉所有后来的录音。capturerFlags 只能填 0（ArkTS 没有低时延的采集器）
    const capturerInfo: audio.AudioCapturerInfo = {
      source: audio.SourceType.SOURCE_TYPE_MIC,
      capturerFlags: 0
    };
    const options: audio.AudioCapturerOptions = { streamInfo: streamInfo, capturerInfo: capturerInfo };
    return options;
  }

  /** 挂上录音器的回调（收数据、被打断、状态变了）；挂不上回错误说明（hilog 里记一条），都挂上了回空串 */
  private listen(capturer: audio.AudioCapturer, id: number): string {
    try {
      capturer.on('readData', (buffer: ArrayBuffer) => {
        this.onData(id, buffer);
      });
      capturer.on('audioInterrupt', (event: audio.InterruptEvent) => {
        this.onInterrupt(id, event);
      });
      capturer.on('stateChange', (state: audio.AudioState) => {
        hilog.info(DOMAIN, TAG, 'voice capturer %{public}d state %{public}s', id, stateName(state));
      });
      return '';
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'capturer listen failed: %{public}s', JSON.stringify(e));
      return errorText(e as BusinessError);
    }
  }

  private onData(id: number, buffer: ArrayBuffer): void {
    if (id !== this.capturerId || !this.recording) {
      return;
    }
    const now = uptime();
    if (this.firstDataAt === 0) {
      this.firstDataAt = now;
    }
    if (this.bytes + buffer.byteLength <= MAX_TAKE_BYTES) {
      // 拷一份：回调返回后系统可能复用这块内存
      this.chunks.push(buffer.slice(0));
      this.bytes += buffer.byteLength;
    }
    const samples = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] / 32768;
      this.sumSquares += v * v;
    }
    this.sampleCount += samples.length;
    if (this.sampleCount > 0 && now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      const event: VoiceEvent = { type: 'level', id: id, rms: Math.sqrt(this.sumSquares / this.sampleCount) };
      this.lastLevelAt = now;
      this.sumSquares = 0;
      this.sampleCount = 0;
      this.push(event);
    }
  }

  /** 录着的时候被系统打断（来电、别的应用要麦克风）：这个录音器不再用，放掉，告诉网页 */
  private onInterrupt(id: number, event: audio.InterruptEvent): void {
    hilog.info(DOMAIN, TAG, 'voice capturer %{public}d interrupt: force %{public}d, hint %{public}d', id, event.forceType, event.hintType);
    if (id !== this.capturerId || this.capturer === undefined) {
      return;
    }
    const stopped = event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP ||
      event.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE;
    if (!stopped) {
      return;
    }
    this.release();
    const message = event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP ? 'INTERRUPT_HINT_STOP' : 'INTERRUPT_HINT_PAUSE';
    const notice: VoiceEvent = { type: 'error', id: id, reason: 'interrupted', message: message };
    this.push(notice);
  }

  private push(event: VoiceEvent): void {
    this.emit(JSON.stringify(event));
  }

  private resetTake(): void {
    this.chunks = [];
    this.bytes = 0;
    this.firstDataAt = 0;
    this.lastLevelAt = 0;
    this.sumSquares = 0;
    this.sampleCount = 0;
  }

  private takeBytes(): Uint8Array {
    const out = new Uint8Array(this.bytes);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(new Uint8Array(chunk), at);
      at += chunk.byteLength;
    }
    return out;
  }

  private async releaseCapturer(capturer: audio.AudioCapturer): Promise<void> {
    try {
      capturer.off('readData');
      capturer.off('audioInterrupt');
      capturer.off('stateChange');
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'capturer off failed: %{public}s', JSON.stringify(e));
    }
    try {
      await capturer.release();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'capturer release failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 排进队里，前一个做完再做；前一个失败了也接着做 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run: Promise<T> = this.queue.then(op);
    this.queue = run.then((): void => {
    }, (): void => {
    });
    return run;
  }

  /**
   * 麦克风权限：有了直接用；没有就向用户要（系统弹框）。用户拒过的系统不再弹，这时只有按下（userAction，用户自己的动作）
   * 才弹"去设置里打开"的框（requestPermissionOnSetting）
   */
  private async ensurePermission(userAction: boolean): Promise<PermissionResult> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const flags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION;
      const tokenId = bundleManager.getBundleInfoForSelfSync(flags).appInfo.accessTokenId;
      if (atManager.checkAccessTokenSync(tokenId, MICROPHONE) === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        return permission(true, '', '');
      }
      const asked = await atManager.requestPermissionsFromUser(this.context, [MICROPHONE]);
      if (asked.authResults.length > 0 && asked.authResults[0] === 0) {
        return permission(true, '', '');
      }
      const shownList = asked.dialogShownResults;
      const shown = shownList === undefined || shownList.length === 0 || shownList[0];
      if (userAction && !shown) {
        const statuses = await atManager.requestPermissionOnSetting(this.context, [MICROPHONE]);
        if (statuses.length > 0 && statuses[0] === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
          return permission(true, '', '');
        }
      }
      return permission(false, 'denied', t('harmony.voice.noPermission'));
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'request microphone failed: %{public}s', JSON.stringify(e));
      return permission(false, 'failed', t('harmony.voice.permissionError', { 'error': errorText(e as BusinessError) }));
    }
  }
}
