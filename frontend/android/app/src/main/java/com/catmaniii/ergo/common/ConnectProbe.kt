package com.catmaniii.ergo.common

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

/** 测的结果：failure 是 null 就是连上了、对面是二狗；detail 是给人看的原话（只有 OTHER 用得上） */
data class ConnectResult(val failure: ConnectFailure?, val detail: String = "")

/**
 * 真的请求一次（对应鸿蒙 common/ConnectProbe.ets）：GET <来源>/api/access，约 10 秒没回就算超时，确认回话的是二狗。
 * 不带任何 cookie（HttpURLConnection 不碰 WebView 的 cookie），不跟跳转（跳到别处的不算二狗）。后台线程跑，回主线程；取消后不再回。
 */
class ConnectProbe(private val origin: String, private val onDone: (ConnectResult) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var cancelled = false
    @Volatile private var connection: HttpURLConnection? = null

    fun start() {
        val thread = Thread({ run() }, "ergo-connect-probe")
        thread.isDaemon = true
        thread.start()
        // connectTimeout 和 readTimeout 分开算，一共可能到 20 秒；整个过程到点就断开
        main.postDelayed(watchdog, TIMEOUT_MS.toLong())
    }

    fun cancel() {
        cancelled = true
        main.removeCallbacks(watchdog)
        disconnect()
    }

    private val watchdog = Runnable {
        if (cancelled) return@Runnable
        cancelled = true
        disconnect()
        onDone(ConnectResult(ConnectFailure.TIMEOUT))
    }

    /** 断开要写网络（https 要发关闭通知），不能在主线程：主线程写网络系统直接抛错 */
    private fun disconnect() {
        val conn = connection ?: return
        val thread = Thread({
            try {
                conn.disconnect()
            } catch (e: Exception) {
                Log.i(TAG, "connect probe disconnect failed: ${e.javaClass.simpleName}")
            }
        }, "ergo-connect-probe-close")
        thread.isDaemon = true
        thread.start()
    }

    private fun finish(result: ConnectResult) {
        main.post {
            if (cancelled) return@post
            cancelled = true
            main.removeCallbacks(watchdog)
            onDone(result)
        }
    }

    private fun run() {
        try {
            val conn = URL("$origin$ACCESS_PATH").openConnection() as HttpURLConnection
            connection = conn
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.setRequestProperty("Accept", "application/json")
            val status = conn.responseCode
            val body = if (status in 200..299) conn.inputStream.use { readSome(it) } else ""
            conn.disconnect()
            finish(if (isErgoAccess(status, body)) ConnectResult(null) else ConnectResult(ConnectFailure.NOT_ERGO))
        } catch (e: Exception) {
            if (cancelled) return
            // 只记种类，不记地址和原话
            Log.i(TAG, "connect probe failed: ${e.javaClass.simpleName}")
            finish(ConnectResult(classifyConnectFailure(e), e.javaClass.simpleName))
        }
    }

    /** 只读开头：二狗的这个回话很短，别的网站的页面不用读完 */
    private fun readSome(stream: java.io.InputStream): String {
        val buffer = ByteArray(MAX_BODY_BYTES)
        var used = 0
        while (used < buffer.size) {
            val n = stream.read(buffer, used, buffer.size - used)
            if (n < 0) break
            used += n
        }
        return String(buffer, 0, used, Charsets.UTF_8)
    }

    companion object {
        /** 约 10 秒（错误文案里也写着 10 秒） */
        const val TIMEOUT_MS = 10_000
        /** 协议包 http.ts 的 HTTP_PATHS.access */
        const val ACCESS_PATH = "/api/access"
        private const val MAX_BODY_BYTES = 16 * 1024
    }
}
