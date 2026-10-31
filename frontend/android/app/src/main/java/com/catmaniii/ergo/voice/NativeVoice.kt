package com.catmaniii.ergo.voice

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.t
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.sqrt

/** 录音的格式：16 kHz、单声道、16 位小端 PCM（和鸿蒙一样；语音识别够用，60 秒不到 2 MB） */
private const val SAMPLE_RATE = 16000
private const val CHANNELS = 1
private const val BITS_PER_SAMPLE = 16
/** 录着的时候多久往网页推一次音量（毫秒） */
private const val LEVEL_INTERVAL_MS = 50L
/** 一段最多留多少字节：网页 60 秒自动发送，多留 10 秒余量，超出的丢掉 */
private const val MAX_TAKE_BYTES = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * 70

/** 向用户要麦克风权限（MainActivity 实现） */
interface MicrophoneAccess {
    /** 现在有没有 */
    fun granted(): Boolean
    /** 要一次。用户"拒绝且不再询问"过的系统不再弹框：userAction 为真（按下引起的）时带用户去系统设置（对应鸿蒙的 requestPermissionOnSetting） */
    fun request(userAction: Boolean, done: (Boolean) -> Unit)
}

private fun failure(reason: String, message: String): String = JSONObject().put("ok", false).put("reason", reason).put("message", message).toString()

/**
 * 原生录音（对应鸿蒙 voice/NativeVoice.ets，63 号票）：AudioRecord 备好但不占麦克风，按下才开始。
 * - prepare：建 AudioRecord，它还没 startRecording，不采集、麦克风指示灯不亮；没权限先向用户要；
 * - start：按下时 startRecording，读线程收 PCM，每 50 毫秒往网页推一次音量；
 * - stop：松手 stop（录音器留着，下次还能直接开始），把这一段 PCM 用 base64 交给网页，网页加 WAV 头上传；
 * - discard：丢掉这一段；release：离开语音模式、切到后台、页面重新加载时放掉录音器。
 * 录音器上的操作都在一个单线程队列里一个一个做；每放掉一次 generation 加一，还没建好的那次建好后马上放掉。
 * 录着的时候被系统打断（来电、别的应用要麦克风，安卓 10 起系统会把这边静音）：放掉录音器，告诉网页（error），下次按下再备好。
 * 回给网页的都切回主线程（通道只能在主线程发）。
 */
class NativeVoice(
    private val context: Context,
    private val access: MicrophoneAccess,
    /** 往网页推（window.__ergoVoice） */
    private val emit: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val queue = Executors.newSingleThreadExecutor()
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @Volatile private var record: AudioRecord? = null
    /** 现在这个录音器的编号（网页据此丢掉旧录音器的消息） */
    @Volatile private var capturerId = 0
    /** 每放掉一次加一：还在排队、还在建的 prepare 据此作废 */
    @Volatile private var generation = 0
    /** 在收这一段的数据 */
    @Volatile private var recording = false
    private var reader: Thread? = null
    private val take = ByteArrayOutputStream()
    private val takeLock = Any()
    private var startCalledAt = 0L
    private var firstDataAt = 0L
    private var silencedWatcher: AudioManager.AudioRecordingCallback? = null

    private fun enqueue(work: () -> Unit) = queue.execute {
        try {
            work()
        } catch (e: Exception) {
            Log.e(TAG, "voice operation failed", e)
        }
    }

    private fun onMain(work: () -> Unit) {
        main.post(work)
    }

    /** 备好录音器；已经备好就沿用。回 { ok, id, prepareMs, state } 或 { ok: false, reason, message } */
    fun prepare(userAction: Boolean, reply: (String) -> Unit) {
        val ticket = generation
        val existing = record
        if (existing != null) {
            reply(JSONObject().put("ok", true).put("id", capturerId).put("prepareMs", 0).put("state", stateName(existing)).toString())
            return
        }
        if (access.granted()) {
            create(ticket, reply)
            return
        }
        access.request(userAction) { granted ->
            if (granted) create(ticket, reply) else reply(failure("denied", t("harmony.voice.noPermission")))
        }
    }

    @SuppressLint("MissingPermission")
    private fun create(ticket: Int, reply: (String) -> Unit) = enqueue {
        if (ticket != generation) {
            onMain { reply(failure("cancelled", t("harmony.voice.releasedEarly"))) }
            return@enqueue
        }
        val existing = record
        if (existing != null) {
            val json = JSONObject().put("ok", true).put("id", capturerId).put("prepareMs", 0).put("state", stateName(existing)).toString()
            onMain { reply(json) }
            return@enqueue
        }
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            onMain { reply(failure("denied", t("harmony.voice.noPermission"))) }
            return@enqueue
        }
        val begin = SystemClock.uptimeMillis()
        val built = try {
            val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            // 音源用 MIC：和鸿蒙的 SOURCE_TYPE_MIC 一样，不开通话的回声消除那一套
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuffer * 2, SAMPLE_RATE / 5))
        } catch (e: Exception) {
            Log.e(TAG, "create AudioRecord failed", e)
            val message = t("harmony.voice.createFailedWith", mapOf("error" to (e.message ?: e.javaClass.simpleName)))
            onMain { reply(failure("failed", message)) }
            return@enqueue
        }
        if (built.state != AudioRecord.STATE_INITIALIZED) {
            built.release()
            onMain { reply(failure("failed", t("harmony.voice.createFailed"))) }
            return@enqueue
        }
        val prepareMs = SystemClock.uptimeMillis() - begin
        if (ticket != generation) {
            // 建的时候网页（或 App）已经放掉了：建好的马上放掉
            built.release()
            onMain { reply(failure("cancelled", t("harmony.voice.releasedEarly"))) }
            return@enqueue
        }
        val id = capturerId + 1
        capturerId = id
        record = built
        watchSilenced(built, id)
        Log.i(TAG, "voice capturer $id prepared in $prepareMs ms")
        val json = JSONObject().put("ok", true).put("id", id).put("prepareMs", prepareMs).put("state", stateName(built)).toString()
        onMain { reply(json) }
    }

    /** 开始采集（按下）。回 { ok, id } 或 { ok: false, reason, message } */
    fun start(reply: (String) -> Unit) {
        val calledAt = SystemClock.uptimeMillis()
        enqueue {
            val current = record
            if (current == null) {
                onMain { reply(failure("failed", t("harmony.voice.notPrepared"))) }
                return@enqueue
            }
            val id = capturerId
            resetTake()
            startCalledAt = calledAt
            recording = true
            try {
                current.startRecording()
            } catch (e: IllegalStateException) {
                recording = false
                Log.e(TAG, "startRecording failed", e)
                val message = t("harmony.voice.startFailed", mapOf("error" to (e.message ?: e.javaClass.simpleName)))
                onMain { reply(failure("failed", message)) }
                return@enqueue
            }
            if (current.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                // 麦克风被别的应用占着时系统不抛错，只是开不起来
                recording = false
                val message = t("harmony.voice.startFailed", mapOf("error" to "recordingState ${current.recordingState}"))
                onMain { reply(failure("failed", message)) }
                return@enqueue
            }
            startReader(current, id)
            val json = JSONObject().put("ok", true).put("id", id).toString()
            onMain { reply(json) }
        }
    }

    /** 停下（松手），交出这一段；录音器留给下一条 */
    fun stop(reply: (String) -> Unit) = enqueue {
        val current = record
        if (current == null || !recording) {
            onMain { reply(failure("failed", t("harmony.voice.notRecording"))) }
            return@enqueue
        }
        val id = capturerId
        recording = false
        try {
            current.stop()
        } catch (e: IllegalStateException) {
            // 停不下来也把已经收到的交出去
            Log.e(TAG, "AudioRecord stop failed", e)
        }
        reader?.join(500)
        reader = null
        val pcm = synchronized(takeLock) { take.toByteArray() }
        val first = firstDataAt
        val startedAt = startCalledAt
        resetTake()
        val message = JSONObject()
            .put("ok", true)
            .put("id", id)
            .put("pcm", Base64.encodeToString(pcm, Base64.NO_WRAP))
            .put("sampleRate", SAMPLE_RATE)
            .put("channels", CHANNELS)
            .put("bitsPerSample", BITS_PER_SAMPLE)
        if (first > 0) message.put("firstDataMs", first - startedAt)
        Log.i(TAG, "voice take: ${pcm.size} bytes, first data after ${if (first > 0) first - startedAt else -1} ms")
        val json = message.toString()
        onMain { reply(json) }
    }

    /** 丢掉这一段（上划取消、太短、出错）：停下、扔掉；录音器留着 */
    fun discard() = enqueue {
        val current = record
        if (current == null || !recording) return@enqueue
        recording = false
        try {
            current.stop()
        } catch (e: IllegalStateException) {
            Log.e(TAG, "AudioRecord stop (discard) failed", e)
        }
        reader?.join(500)
        reader = null
        resetTake()
    }

    /** 放掉录音器（网页要的：离开语音模式、切到后台）；还在建的那次建好后马上放掉 */
    fun release() {
        generation += 1
        recording = false
        val current = record
        record = null
        if (current == null) return
        enqueue {
            unwatchSilenced()
            try {
                if (current.recordingState == AudioRecord.RECORDSTATE_RECORDING) current.stop()
            } catch (e: IllegalStateException) {
                Log.w(TAG, "AudioRecord stop (release) failed", e)
            }
            reader?.join(500)
            reader = null
            current.release()
            resetTake()
        }
    }

    /** App 自己放掉录音器（切到后台、页面重新加载、换地址）：放掉，并告诉网页（released） */
    fun releaseByApp(reason: String) {
        val had = record != null
        val id = capturerId
        release()
        if (had) emit(JSONObject().put("type", "released").put("id", id).put("reason", reason).toString())
    }

    /** 整个不用了（换地址、App 退出） */
    fun close() {
        release()
        queue.shutdown()
    }

    private fun startReader(current: AudioRecord, id: Int) {
        val thread = Thread({ readLoop(current, id) }, "ergo-voice-reader")
        reader = thread
        thread.start()
    }

    private fun readLoop(current: AudioRecord, id: Int) {
        val buffer = ByteArray(SAMPLE_RATE * 2 / 25) // 40 毫秒一块
        var lastLevelAt = 0L
        var sumSquares = 0.0
        var sampleCount = 0
        while (recording && id == capturerId) {
            val read = current.read(buffer, 0, buffer.size)
            if (read < 0) {
                Log.w(TAG, "AudioRecord read failed: $read")
                if (recording) failFromReader(id, "failed", "AudioRecord read $read")
                return
            }
            if (read == 0) continue
            val now = SystemClock.uptimeMillis()
            if (firstDataAt == 0L) firstDataAt = now
            synchronized(takeLock) {
                if (take.size() + read <= MAX_TAKE_BYTES) take.write(buffer, 0, read)
            }
            var i = 0
            while (i + 1 < read) {
                val sample = ((buffer[i + 1].toInt() shl 8) or (buffer[i].toInt() and 0xFF)).toShort()
                val v = sample / 32768.0
                sumSquares += v * v
                sampleCount += 1
                i += 2
            }
            if (sampleCount > 0 && now - lastLevelAt >= LEVEL_INTERVAL_MS) {
                val json = JSONObject().put("type", "level").put("id", id).put("rms", sqrt(sumSquares / sampleCount)).toString()
                lastLevelAt = now
                sumSquares = 0.0
                sampleCount = 0
                onMain { emit(json) }
            }
        }
    }

    private fun failFromReader(id: Int, reason: String, message: String) {
        onMain {
            if (id != capturerId || record == null) return@onMain
            release()
            emit(JSONObject().put("type", "error").put("id", id).put("reason", reason).put("message", message).toString())
        }
    }

    /** 安卓 10 起：别的应用（来电、别的录音）抢走麦克风时系统把这边静音，当被打断（对应鸿蒙的 audioInterrupt）；更早的系统没有这个信号 */
    private fun watchSilenced(current: AudioRecord, id: Int) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        unwatchSilenced()
        val session = current.audioSessionId
        val watcher = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                val mine = configs.firstOrNull { it.clientAudioSessionId == session } ?: return
                if (mine.isClientSilenced && recording && id == capturerId) failFromReader(id, "interrupted", "CLIENT_SILENCED")
            }
        }
        silencedWatcher = watcher
        audioManager.registerAudioRecordingCallback(watcher, main)
    }

    private fun unwatchSilenced() {
        val watcher = silencedWatcher ?: return
        silencedWatcher = null
        audioManager.unregisterAudioRecordingCallback(watcher)
    }

    private fun resetTake() {
        synchronized(takeLock) { take.reset() }
        firstDataAt = 0L
    }

    private fun stateName(current: AudioRecord): String = when (current.recordingState) {
        AudioRecord.RECORDSTATE_RECORDING -> "RUNNING"
        else -> "PREPARED"
    }
}
