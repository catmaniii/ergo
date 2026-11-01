package com.catmaniii.ergo.download

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.CookieManager
import android.webkit.URLUtil
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.originOf
import com.catmaniii.ergo.common.t
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.util.concurrent.Executors

/** 重定向最多跟几次 */
private const val MAX_REDIRECTS = 10

/** 文件名里不能有的字符换成下划线，太长的截短；空的叫"下载的文件" */
fun safeFileName(name: String): String {
    val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim()
    return if (cleaned.isNotEmpty()) cleaned.take(120) else t("harmony.downloads.defaultName")
}

/** 服务端给的文件名（filename* 优先，再 filename，再按地址猜） */
fun fileNameOf(url: String, contentDisposition: String?, mime: String?): String {
    if (contentDisposition != null) {
        val extended = Regex("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)").find(contentDisposition)?.groupValues?.get(1)
        if (extended != null) {
            try {
                return URLDecoder.decode(extended.trim(), "UTF-8")
            } catch (_: Exception) {
                // 解不开就按下面的
            }
        }
    }
    return URLUtil.guessFileName(url, contentDisposition, mime)
}

/** 下载的请求带不带 cookie：二狗的设备凭证只给二狗自己的页面发起的下载（外部网页指向二狗地址的下载不带，SameSite=Strict 的意思） */
fun cookieAllowed(target: String, initiator: String, serverOrigin: String): Boolean {
    if (serverOrigin.isEmpty() || originOf(target) != serverOrigin) return true
    return originOf(initiator) == serverOrigin
}

/** 一次下载的要素 */
class DownloadRequest(val url: String, val userAgent: String, val contentDisposition: String?, val mime: String?, val length: Long, val initiator: String)

/**
 * 拦下载（对应鸿蒙的 DownloadDivert，160 号票，原生浏览器里能渲染的文件）：want 说要不要拦——拦下的照样下进缓存，但不提示、不弹"保存到"，
 * 下完 finished 交出缓存里的路径（由拦的人管，删不删、存不存）；失败 failed
 */
interface DownloadDivert {
    fun want(request: DownloadRequest, name: String): Boolean
    fun finished(request: DownloadRequest, name: String, file: File)
    fun failed(request: DownloadRequest)
    /** 这一次拦没拦（下载失败时选提示语） */
    fun isDiverted(request: DownloadRequest): Boolean
}

/** 存好了一个文件（165 号票，下载记录）：名字、存在哪（系统"保存到"给的地址）、大小（字节）、类型（不知道是空串） */
typealias DownloadSaved = (name: String, uri: String, size: Long, mime: String) -> Unit

/** 弹系统的"保存到"（MainActivity 起系统界面）；用户取消回 null */
interface SavePicker {
    fun save(name: String, mime: String, done: (Uri?) -> Unit)
}

/**
 * 网页里的下载（对应鸿蒙 download/WebDownloads.ets，96 号票）：安卓的 WebView 不自己下载，这里自己下到缓存，下完弹系统的"保存到"让用户选位置，
 * 再拷过去、删掉缓存里的那份。自己发请求所以 cookie 也要自己带：只带这个地址该带的；不自动跟重定向，每一跳重新算 cookie，
 * 免得把二狗的设备凭证跟着重定向带到别的网站。
 */
class WebDownloads(
    private val context: Context,
    private val notify: (String) -> Unit,
    private val picker: SavePicker,
    /** 二狗现在的来源（算 cookie 带不带用） */
    private val serverOrigin: () -> String,
    private val divert: DownloadDivert? = null,
    private val saved: DownloadSaved? = null,
    /** 读 blob: 的内容（只在页面里才有，回 data: 地址，读不到回 null）；主界面那份没有（二狗的网页不靠 blob: 下载） */
    private val readBlob: ((String, (String?) -> Unit) -> Unit)? = null,
) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()
    private val dir = File(context.cacheDir, "downloads")
    /** 缓存里的路径 → 服务端给的类型（存好时记进下载记录） */
    private val mimes = HashMap<String, String>()

    /** WebView 的 DownloadListener 交来的 */
    fun begin(request: DownloadRequest) {
        val name = safeFileName(fileNameOf(request.url, request.contentDisposition, request.mime))
        val diverted = divert?.want(request, name) == true
        val scheme = request.url.substringBefore(':').lowercase()
        if (scheme == "blob" && readBlob != null) {
            readBlob.invoke(request.url) { data ->
                if (data == null) {
                    notify(t("harmony.downloads.cantStart", mapOf("name" to name)))
                } else {
                    begin(DownloadRequest(data, request.userAgent, request.contentDisposition, request.mime, data.length.toLong(), request.initiator))
                }
            }
            return
        }
        if (scheme != "http" && scheme != "https" && scheme != "data") {
            Log.w(TAG, "download refused: scheme $scheme")
            notify(t("harmony.downloads.cantStart", mapOf("name" to name)))
            return
        }
        if (!diverted) notify(t("harmony.downloads.started", mapOf("name" to name)))
        dir.mkdirs()
        val file = File(dir, "${System.currentTimeMillis()}-$name")
        if (saved != null) mimes[file.path] = request.mime ?: ""
        io.execute {
            val failure = try {
                if (scheme == "data") writeDataUrl(request.url, file) else fetch(request, file)
                null
            } catch (e: Exception) {
                Log.w(TAG, "download failed: ${e.javaClass.simpleName}")
                e
            }
            main.post {
                if (failure != null) {
                    failed(request, name, file, failure)
                } else if (diverted) {
                    divert?.finished(request, name, file)
                } else {
                    saveFile(file, name, false)
                }
            }
        }
    }

    private fun writeDataUrl(url: String, file: File) {
        val comma = url.indexOf(',')
        require(comma > 0)
        val meta = url.substring(5, comma)
        val body = url.substring(comma + 1)
        val bytes = if (meta.endsWith(";base64")) Base64.decode(body, Base64.DEFAULT) else URLDecoder.decode(body, "UTF-8").toByteArray()
        file.writeBytes(bytes)
    }

    private fun fetch(request: DownloadRequest, file: File) {
        var target = request.url
        for (hop in 0..MAX_REDIRECTS) {
            val connection = URL(target).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 30_000
            connection.readTimeout = 60_000
            connection.setRequestProperty("User-Agent", request.userAgent)
            if (cookieAllowed(target, request.initiator, serverOrigin())) {
                CookieManager.getInstance().getCookie(target)?.let { connection.setRequestProperty("Cookie", it) }
            }
            try {
                val code = connection.responseCode
                if (code in 300..399) {
                    val location = connection.getHeaderField("Location") ?: throw HttpFailure(code)
                    target = URL(URL(target), location).toString()
                    if (originOf(target).isEmpty()) throw HttpFailure(code)
                    continue
                }
                if (code >= 400) throw HttpFailure(code)
                connection.inputStream.use { input -> FileOutputStream(file).use { input.copyTo(it) } }
                return
            } finally {
                connection.disconnect()
            }
        }
        throw HttpFailure(310)
    }

    private class HttpFailure(val code: Int) : Exception("HTTP $code")

    /**
     * 把缓存里的一个文件弹"保存到"存出去（文件名默认 name）；keep 为真时缓存里那份留着（160 号票：拦下的下载点"下载"，
     * 可能还要再看、再存），否则存完、取消都删掉。mimeType：别处取到的文件（359 号票，长按元素）记进下载记录的类型
     */
    fun saveFile(file: File, name: String, keep: Boolean, mimeType: String? = null) {
        if (mimeType != null) mimes[file.path] = mimeType
        val mime = mimes[file.path] ?: ""
        picker.save(name, mime.ifEmpty { "*/*" }) { uri ->
            if (uri == null) {
                if (!keep) file.delete()
                notify(t("harmony.downloads.notSaved", mapOf("name" to name)))
                return@save
            }
            copyTo(file, uri, name, mime, keep)
        }
    }

    private fun copyTo(file: File, uri: Uri, name: String, mime: String, keep: Boolean) {
        mimes.remove(file.path)
        val size = file.length()
        io.execute {
            val ok = try {
                val out = context.contentResolver.openOutputStream(uri, "wt") ?: throw IllegalStateException("no output stream")
                out.use { stream -> file.inputStream().use { it.copyTo(stream) } }
                true
            } catch (e: Exception) {
                Log.e(TAG, "copy download failed", e)
                false
            }
            if (!keep) file.delete()
            main.post {
                if (ok) {
                    notify(t("harmony.downloads.saved", mapOf("name" to name)))
                    // 下载记录（165 号票）
                    saved?.invoke(name, uri.toString(), size, mime)
                } else {
                    notify(t("harmony.downloads.saveFailed", mapOf("name" to name)))
                }
            }
        }
    }

    private fun failed(request: DownloadRequest, name: String, file: File, failure: Exception) {
        val code = ((failure as? HttpFailure)?.code ?: -1).toString()
        mimes.remove(file.path)
        file.delete()
        val diverted = divert?.isDiverted(request) == true
        if (diverted) divert?.failed(request)
        notify(t(if (diverted) "harmony.downloads.openFailed" else "harmony.downloads.failed", mapOf("name" to name, "code" to code)))
    }
}
