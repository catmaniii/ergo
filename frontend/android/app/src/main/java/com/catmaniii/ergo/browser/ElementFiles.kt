package com.catmaniii.ergo.browser

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.PixelCopy
import android.webkit.CookieManager
import android.webkit.WebView
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.originOf
import com.catmaniii.ergo.common.t
import com.catmaniii.ergo.download.cookieAllowed
import com.catmaniii.ergo.download.fileNameOf
import com.catmaniii.ergo.download.safeFileName
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** 重定向最多跟几次（和下载一样） */
private const val MAX_REDIRECTS = 10
/** 分段读出来时一段多少字节（base64 之后约 512 KB） */
private const val READ_BYTES = 384 * 1024
/** 下载开头等多久：这么久里失败的回原因，还在下的先回"开始了" */
private const val DOWNLOAD_WAIT_MS = 5000L

/**
 * 按来源页该带什么 Referer（和浏览器默认的 strict-origin-when-cross-origin 一样）：同一个网站带来源页全地址（去掉 #），跨站只带网站，
 * https 到 http 不带。防盗链的图要它；每一跳都重新算，免得跟着重定向把全地址带到别的网站
 */
fun refererFor(page: String, target: String): String? {
    val from = originOf(page)
    val to = originOf(target)
    if (from.isEmpty() || to.isEmpty()) return null
    if (from == to) return page.substringBefore('#')
    if (from.startsWith("https:") && to.startsWith("http:")) return null
    return "$from/"
}

/** 取的时候不成：too-large 太大、http 服务端回了错（status）、bad-url 地址不对、network 连不上 */
private class FetchFailure(val code: String, val status: Int = 0) : Exception(code)

/**
 * 长按网页元素的圆钮（对应鸿蒙 browser/ElementFiles.ets）：秘书要元素的内容、要下载时，App 这一侧的本事，都经 browserTool（op 以 element 开头）：
 * - elementFetch：把一个地址取进缓存。页面里 fetch 跨站会被挡，这里自己发请求，带这个地址该带的 cookie 和来源页（防盗链、要登录的图都取得到）；
 *   不自动跟重定向，每一跳重新算，二狗的设备凭证只给二狗自己的页面发起的请求（cookieAllowed，外部网页的元素指向二狗地址的不带）；
 * - elementShot：截网页的一块（图取不到时用，PixelCopy：连视频都截得到，系统选文字的工具条在别的窗口上，截不进来）；
 * - elementRead、elementWrite、elementDrop：缓存里的那一份分段读出来（传进媒体库）、分段写进去（blob、canvas 的字节）、放掉；
 * - elementSave：缓存里的那一份走"下载管理"那条路（WebDownloads 弹"保存到"，存好了进下载记录）；
 * - elementDownload：下载一个地址，取法同 elementFetch，下完同 elementSave。开头几秒就失败的回原因，还在下的先回 ok，之后失败的弹提示。
 * 网页（packages/web/src/plugins/browsing/element-files.ts）按回的 code 写原因给秘书。
 */
class ElementFiles(
    private val activity: Activity,
    /** 浏览器的 WebView（还没建是 null） */
    private val web: () -> WebView?,
    /** 二狗现在的来源（算 cookie 带不带用） */
    private val serverOrigin: () -> String,
    private val notify: (String) -> Unit,
    /** 缓存里的文件弹"保存到"，存好了记进下载记录（存好、取消都删掉缓存里的） */
    private val save: (file: File, name: String, mime: String) -> Unit,
) {
    private class Entry(val file: File, var name: String, var mime: String)

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()
    private val dir = File(activity.cacheDir, "element-files")
    private val entries = ConcurrentHashMap<String, Entry>()
    private val next = AtomicInteger(1)

    init {
        // 上次留下的：App 被杀时还没放掉的
        io.execute { dir.listFiles()?.forEach { it.delete() } }
    }

    fun run(op: String, json: String, reply: (String) -> Unit) {
        val args = try {
            JSONObject(json)
        } catch (_: Exception) {
            JSONObject()
        }
        when (op) {
            "elementFetch" -> fetchFile(args.optString("url"), args.optLong("maxBytes", Long.MAX_VALUE), reply)
            "elementShot" -> shot(args, reply)
            "elementRead" -> read(args.optString("id"), args.optLong("offset"), reply)
            "elementWrite" -> write(args.optString("id"), args.optString("base64"), reply)
            "elementSave" -> reply(saveEntry(args.optString("id"), args.optString("name"), args.optString("mime")))
            "elementDownload" -> download(args.optString("url"), reply)
            "elementDrop" -> {
                entries.remove(args.optString("id"))?.file?.delete()
                reply(ok().toString())
            }
            else -> reply(failure("bad-op").toString())
        }
    }

    private fun ok() = JSONObject().put("ok", true)

    private fun failure(code: String, status: Int = 0): JSONObject {
        val out = JSONObject().put("ok", false).put("code", code)
        return if (status > 0) out.put("status", status) else out
    }

    private fun described(id: String, entry: Entry) =
        ok().put("id", id).put("name", entry.name).put("mime", entry.mime).put("size", entry.file.length())

    private fun newEntry(name: String, mime: String): Pair<String, Entry> {
        dir.mkdirs()
        val id = "c${next.getAndIncrement()}"
        val entry = Entry(File(dir, id), name, mime)
        entries[id] = entry
        return id to entry
    }

    /** 自己发请求把一个地址取进文件：回服务端给的名字和类型；不成抛 FetchFailure */
    private fun fetchInto(url: String, page: String, userAgent: String, server: String, maxBytes: Long, file: File): Pair<String, String> {
        var target = url
        for (hop in 0..MAX_REDIRECTS) {
            if (originOf(target).isEmpty()) throw FetchFailure("bad-url")
            val connection = try {
                URL(target).openConnection() as HttpURLConnection
            } catch (_: Exception) {
                throw FetchFailure("bad-url")
            }
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 30_000
            connection.readTimeout = 60_000
            connection.setRequestProperty("User-Agent", userAgent)
            refererFor(page, target)?.let { connection.setRequestProperty("Referer", it) }
            if (cookieAllowed(target, page, server)) {
                CookieManager.getInstance().getCookie(target)?.let { connection.setRequestProperty("Cookie", it) }
            }
            try {
                val code = connection.responseCode
                if (code in 300..399) {
                    val location = connection.getHeaderField("Location") ?: throw FetchFailure("http", code)
                    target = URL(URL(target), location).toString()
                    continue
                }
                if (code >= 400) throw FetchFailure("http", code)
                if (connection.contentLengthLong > maxBytes) throw FetchFailure("too-large")
                connection.inputStream.use { input ->
                    FileOutputStream(file).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            total += n
                            if (total > maxBytes) throw FetchFailure("too-large")
                            output.write(buffer, 0, n)
                        }
                    }
                }
                val mime = (connection.contentType ?: "").substringBefore(';').trim()
                return safeFileName(fileNameOf(target, connection.getHeaderField("Content-Disposition"), mime)) to mime
            } finally {
                connection.disconnect()
            }
        }
        throw FetchFailure("http", 310)
    }

    private fun codeOf(e: Exception): JSONObject {
        if (e is FetchFailure) return failure(e.code, e.status)
        Log.w(TAG, "element fetch failed: ${e.javaClass.simpleName}")
        return failure("network")
    }

    private fun fetchFile(url: String, maxBytes: Long, reply: (String) -> Unit) {
        val view = web() ?: return reply(failure("no-web").toString())
        val page = view.url ?: ""
        val userAgent = view.settings.userAgentString
        val server = serverOrigin()
        val (id, entry) = newEntry("", "")
        io.execute {
            val out = try {
                val (name, mime) = fetchInto(url, page, userAgent, server, maxBytes, entry.file)
                entry.name = name
                entry.mime = mime
                described(id, entry)
            } catch (e: Exception) {
                entries.remove(id)
                entry.file.delete()
                codeOf(e)
            }
            main.post { reply(out.toString()) }
        }
    }

    private fun download(url: String, reply: (String) -> Unit) {
        val view = web() ?: return reply(failure("no-web").toString())
        val page = view.url ?: ""
        val userAgent = view.settings.userAgentString
        val server = serverOrigin()
        val (id, entry) = newEntry("", "")
        val replied = AtomicBoolean(false)
        val answer = { text: String -> if (replied.compareAndSet(false, true)) reply(text) }
        val guess = safeFileName(fileNameOf(url, null, null))
        notify(t("harmony.downloads.started", mapOf("name" to guess)))
        main.postDelayed({ answer(ok().toString()) }, DOWNLOAD_WAIT_MS)
        io.execute {
            val failed = try {
                val (name, mime) = fetchInto(url, page, userAgent, server, Long.MAX_VALUE, entry.file)
                entry.name = name
                entry.mime = mime
                null
            } catch (e: Exception) {
                codeOf(e)
            }
            main.post {
                entries.remove(id)
                if (failed == null) {
                    answer(ok().toString())
                    save(entry.file, entry.name, entry.mime)
                } else {
                    entry.file.delete()
                    if (replied.get()) notify(t("harmony.downloads.failed", mapOf("name" to guess, "code" to failed.optInt("status", -1).toString())))
                    answer(failed.toString())
                }
            }
        }
    }

    private fun shot(args: JSONObject, reply: (String) -> Unit) {
        val view = web() ?: return reply(failure("no-web").toString())
        val at = IntArray(2)
        view.getLocationInWindow(at)
        val x = args.optDouble("x", 0.0).toInt()
        val y = args.optDouble("y", 0.0).toInt()
        val width = minOf(args.optDouble("width", 0.0).toInt(), view.width - x)
        val height = minOf(args.optDouble("height", 0.0).toInt(), view.height - y)
        if (width <= 0 || height <= 0) return reply(failure("shot").toString())
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val rect = Rect(at[0] + x, at[1] + y, at[0] + x + width, at[1] + y + height)
        try {
            PixelCopy.request(activity.window, rect, bitmap, { code ->
                if (code != PixelCopy.SUCCESS) {
                    Log.w(TAG, "element shot failed: $code")
                    bitmap.recycle()
                    reply(failure("shot").toString())
                    return@request
                }
                io.execute {
                    val (id, entry) = newEntry("element.png", "image/png")
                    val out = try {
                        FileOutputStream(entry.file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        described(id, entry)
                    } catch (e: Exception) {
                        Log.w(TAG, "element shot write failed", e)
                        entries.remove(id)
                        entry.file.delete()
                        failure("shot")
                    }
                    bitmap.recycle()
                    main.post { reply(out.toString()) }
                }
            }, main)
        } catch (e: Exception) {
            Log.w(TAG, "element shot failed", e)
            reply(failure("shot").toString())
        }
    }

    private fun read(id: String, offset: Long, reply: (String) -> Unit) {
        val entry = entries[id] ?: return reply(failure("gone").toString())
        io.execute {
            val out = try {
                RandomAccessFile(entry.file, "r").use { file ->
                    file.seek(offset)
                    val buffer = ByteArray(READ_BYTES)
                    val n = maxOf(file.read(buffer), 0)
                    ok().put("base64", Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP)).put("done", offset + n >= file.length())
                }
            } catch (e: Exception) {
                Log.w(TAG, "element read failed", e)
                failure("gone")
            }
            main.post { reply(out.toString()) }
        }
    }

    private fun write(id: String, base64: String, reply: (String) -> Unit) {
        val known = entries[id]
        val pair = if (known != null) id to known else newEntry("", "")
        io.execute {
            val out = try {
                FileOutputStream(pair.second.file, true).use { it.write(Base64.decode(base64, Base64.DEFAULT)) }
                ok().put("id", pair.first)
            } catch (e: Exception) {
                Log.w(TAG, "element write failed", e)
                failure("gone")
            }
            main.post { reply(out.toString()) }
        }
    }

    private fun saveEntry(id: String, name: String, mime: String): String {
        val entry = entries.remove(id) ?: return failure("gone").toString()
        save(entry.file, safeFileName(name.ifEmpty { entry.name }), mime.ifEmpty { entry.mime })
        return ok().toString()
    }
}
