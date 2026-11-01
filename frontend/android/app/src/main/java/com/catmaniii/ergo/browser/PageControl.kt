package com.catmaniii.ergo.browser

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.t
import com.catmaniii.ergo.download.safeFileName
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/** 页面桥在页面里的通道对象名；页面桥要的 ergoPageHost.post 由下面的开场脚本接到它上面 */
private const val PAGE_CHANNEL = "__ergoPageChannel"
/** 页面桥脚本（npm run build:android 从 packages/web/src/page-bridge 打包进 assets）和里面口令的占位 */
private const val PAGE_BRIDGE_FILE = "page-bridge.js"
private const val NONCE_MARK = "__ERGO_PAGE_NONCE__"

/**
 * 开场脚本：页面桥照协议要 window.ergoPageHost.post(json)（packages/web/src/page-bridge/protocol.ts 的 PAGE_BRIDGE_HOST），
 * addWebMessageListener 给的对象只有 postMessage，这里接一下。只在主框架接；网页自己的脚本也调得到它，所以每句话都要带页面桥的口令。
 */
private const val PAGE_HOST_PRELUDE =
    "(function(){if(window.top!==window)return;var c=window.$PAGE_CHANNEL;if(!c)return;" +
        "var h=Object.freeze({post:function(j){c.postMessage(String(j))}});" +
        "Object.defineProperty(window,'ergoPageHost',{value:h,writable:false,configurable:false,enumerable:false})})();\n"

/**
 * 网页能调的页面桥方法（交文件那三个由这里自己调），和鸿蒙 browser/PageControl.ets 的 PAGE_OPS 一样，名字和
 * packages/web/src/page-bridge/protocol.ts 的 PageBridgeApi 一致
 */
val PAGE_OPS = listOf("fields", "fill", "mark", "bubble", "pick", "selected", "text", "clearSelection", "snapshot", "click", "refField", "texts", "elementInfo", "elementPrepare", "elementChunk", "elementRect", "elementShotDone")

/** 收起气泡、挑图片窗口（宿主交给页面桥的样子） */
private const val BUBBLE_NONE = "{\"kind\":\"none\"}"
/** 一个文件最大多少字节（和协议的 PAGE_FILE_MAX_BYTES 一样）；往网页里交时一段多大（原始字节，base64 之后约 512 KB） */
private const val FILE_MAX_BYTES = 50L * 1024 * 1024
private const val PAGE_CHUNK_BYTES = 384 * 1024
/** 文件的编号（二狗的网页给的）只认这样的 */
private val FILE_ID = Regex("^[A-Za-z0-9_-]{1,40}$")
/** 页面桥说"要弹选文件对话框的是这个框"之后多久内算数 */
private const val CHOOSER_FIELD_MS = 2000L

private fun outcome(ok: Boolean, count: Int, reason: String): String = JSONObject().put("ok", ok).put("count", count).put("reason", reason).toString()

/** evaluateJavascript 回的是 JSON：字符串去掉一层，别的（null）当空串 */
fun unquoteJs(result: String?): String {
    if (result == null || result == "null") return ""
    if (!result.startsWith("\"")) return result
    return try {
        JSONTokener(result).nextValue() as? String ?: result
    } catch (_: Exception) {
        result
    }
}

/** 拦下的选文件对话框要的系统选择器（MainActivity 起系统界面） */
/** 对话框拦下后这么久之内来的取消，算是给上一个对话框的 */
private const val CHOOSER_STALE_CANCEL_MS = 500L

interface FilePicker {
    fun pick(images: Boolean, accept: List<String>, multiple: Boolean, done: (List<Uri>) -> Unit)
}

/**
 * 页面桥（对应鸿蒙 browser/PageControl.ets）在 App 这一侧：给浏览器的 WebView 注入页面桥脚本（换好口令）、收它报的话转给二狗的网页、
 * 替二狗的网页调页面桥（填字、按钮的样子）、把二狗的网页交来的文件交进网页（两条路：页面桥塞进选文件的框；交给拦下的选文件对话框），
 * 以及拦下网页弹出的选文件对话框（onShowFileChooser）问用户"让二狗选 / 自己选"。
 * 浏览器的 WebView 不挂二狗的原生桥；网页的脚本能碰到的只有 ergoPageHost.post，没有口令说的话一律不认，也收不到任何回话。
 */
class PageControl(
    private val context: Context,
    /** 往二狗的网页推（window.__ergoBrowser） */
    private val emit: (String) -> Unit,
    /** 二狗的网页在不在（有"浏览"页签）：不在时选文件对话框直接用系统的 */
    private val webReady: () -> Boolean,
    private val picker: FilePicker,
) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    /** 这次 App 跑起来的口令：注入时换进脚本，页面桥每句话都带着 */
    private val nonce = UUID.randomUUID().toString().replace("-", "")
    private var web: WebView? = null
    /** 拦下的选文件对话框（等用户选"让二狗选 / 自己选"、等二狗交文件） */
    private var chooser: ValueCallback<Array<Uri>>? = null
    /** 这个对话框是什么时候拦下的 */
    private var chooserAt = 0L
    private var chooserMultiple = false
    private var chooserImages = false
    private var chooserAccept: List<String> = emptyList()
    /** 页面桥最近说的"要弹选文件对话框的是这个框"（网站的脚本调 input.click() 时） */
    private var chooserField = ""
    private var chooserFieldAt = 0L
    /** 二狗的网页写进来的文件：编号 → 写了多少字节 */
    private val staged = HashMap<String, Long>()
    /** 悬浮按钮旁边的气泡开着（二狗的网页最近交给页面桥的样子不是 none）：返回手势先收起它 */
    private var bubbleOpen = false
    /** 挑图片窗口开着：气泡之后收它 */
    private var pickOpen = false
    private var injected = false
    /** 等 blob: 内容的：一次性口令 → 回调 */
    private val blobWaiters = HashMap<String, (String?) -> Unit>()
    private val stagingDir = File(context.cacheDir, "page-files")

    init {
        // 清掉上次留下的文件（App 起来时）
        stagingDir.deleteRecursively()
        stagingDir.mkdirs()
    }

    /** 浏览器的 WebView 建好时：注入页面桥（文档开始时，在网页的脚本之前，所有框架；入口自己只在主框架里装）和它报话的通道 */
    fun install(view: WebView) {
        web = view
        val script = loadScript()
        if (script.isEmpty()) return
        WebViewCompat.addWebMessageListener(view, PAGE_CHANNEL, setOf("*")) { _, message, _, isMainFrame, _ ->
            received(message.data ?: "", isMainFrame)
        }
        WebViewCompat.addDocumentStartJavaScript(view, PAGE_HOST_PRELUDE + script, setOf("*"))
        injected = true
    }

    /** 读 assets 里的页面桥，换好口令；没有（没跑 npm run build:android 打包）就不注入，记一条 */
    private fun loadScript(): String = try {
        val text = context.assets.open(PAGE_BRIDGE_FILE).bufferedReader(Charsets.UTF_8).use { it.readText() }
        if (!text.contains(NONCE_MARK)) {
            Log.e(TAG, "page bridge script has no nonce mark: not injected")
            ""
        } else {
            text.replace(NONCE_MARK, nonce)
        }
    } catch (e: Exception) {
        Log.e(TAG, "page bridge script missing (run npm run build:android)", e)
        ""
    }

    /**
     * 读页面里一个 blob: 地址的内容（网页生成的文件下载）：这种地址只有页面自己读得到。用一次性的口令，不用页面桥的口令
     * （这段脚本是现注入的，网页的脚本钩得到）；网页顶多是把自己的内容换一份，弹的还是系统的"保存到"
     */
    fun readBlob(url: String, done: (String?) -> Unit) {
        val view = web
        if (view == null || !injected) {
            done(null)
            return
        }
        val token = UUID.randomUUID().toString()
        blobWaiters[token] = done
        val script = "(function(){var c=window.$PAGE_CHANNEL,x=new XMLHttpRequest();x.open('GET'," + JSONObject.quote(url) + ");x.responseType='blob';" +
            "var f=function(d){c.postMessage(JSON.stringify({blob:" + JSONObject.quote(token) + ",data:d}))};" +
            "x.onerror=function(){f('')};x.onload=function(){var r=new FileReader();r.onerror=function(){f('')};r.onload=function(){f(r.result)};r.readAsDataURL(x.response)};x.send()})()"
        view.evaluateJavascript(script, null)
    }

    /** 页面桥报来一句：口令对、来自浏览器的主框架才认，转给二狗的网页 */
    private fun received(json: String, isMainFrame: Boolean) {
        val message = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        val blobToken = message.opt("blob")
        if (blobToken is String) {
            val waiter = blobWaiters.remove(blobToken) ?: return
            waiter(message.optString("data").ifEmpty { null })
            return
        }
        if (message.optString("nonce") != nonce) {
            Log.w(TAG, "page message refused: bad nonce")
            return
        }
        if (!isMainFrame) {
            Log.w(TAG, "page message refused: not from the main frame")
            return
        }
        if (message.optString("type") == "chooser-field") {
            val id = message.optJSONObject("field")?.opt("id")
            if (id is String) {
                chooserField = id
                chooserFieldAt = System.currentTimeMillis()
            }
        }
        emit(JSONObject().put("type", "page").put("json", json).toString())
    }

    /** 二狗的网页调页面桥：args 是参数的 JSON 数组（都是字符串） */
    fun run(op: String, args: String, reply: (String) -> Unit) {
        if (op !in PAGE_OPS) {
            reply("")
            return
        }
        val list = try {
            val parsed = JSONArray(args)
            List(parsed.length()) { parsed.get(it).toString() }
        } catch (_: Exception) {
            reply("")
            return
        }
        if (op == "bubble") bubbleOpen = list.isNotEmpty() && !isNone(list[0])
        if (op == "pick") pickOpen = list.isNotEmpty() && !isNone(list[0])
        callPage(op, list, reply)
    }

    private fun isNone(view: String): Boolean = try {
        val kind = JSONObject(view).opt("kind")
        kind !is String || kind == "none"
    } catch (_: Exception) {
        true
    }

    /**
     * 返回手势（MainActivity 先问这里）：气泡开着就告诉二狗的网页收起（它收起、交给页面桥 none），气泡没开、挑图片窗口开着就收窗口，
     * 回 true 表示接住了；都没开回 false，照原来的退网页历史
     */
    fun closeBubble(): Boolean {
        if (bubbleOpen) {
            bubbleOpen = false
            emit(JSONObject().put("type", "bubble-close").toString())
            return true
        }
        if (pickOpen) {
            pickOpen = false
            emit(JSONObject().put("type", "pick-close").toString())
            return true
        }
        return false
    }

    /** 浏览器开始加载别的网页：新页面上没有气泡、挑图片窗口 */
    fun browserPageBegin() {
        bubbleOpen = false
        pickOpen = false
    }

    /** 二狗的网页重新加载、跳走了：没人管的气泡、挑图片窗口收起（新页面开场也会交一次 none） */
    fun hostPageBegin() {
        if (bubbleOpen) {
            bubbleOpen = false
            callPage("bubble", listOf(BUBBLE_NONE)) {}
        }
        if (pickOpen) {
            pickOpen = false
            callPage("pick", listOf(BUBBLE_NONE)) {}
        }
    }

    /** evaluateJavascript 调 window.__ergoPage.<op>(口令, ...参数)，回它回的字符串。op 只来自 PAGE_OPS 和这个文件 */
    private fun callPage(op: String, args: List<String>, reply: (String) -> Unit) {
        val view = web
        if (view == null) {
            reply("")
            return
        }
        val params = (listOf(nonce) + args).joinToString(",") { JSONObject.quote(it) }
        val script = "(function(){var p=window.__ergoPage;return p&&typeof p.$op==='function'?p.$op($params):''})()"
        view.evaluateJavascript(script) { reply(unquoteJs(it)) }
    }

    /** 二狗的网页把一个文件的一段（base64）交来：接在 App 缓存里这个文件的后面 */
    fun writeChunk(id: String, base64: String, reply: (String) -> Unit) {
        if (!FILE_ID.matches(id)) {
            reply(outcome(false, 0, t("harmony.pageControl.badFileId")))
            return
        }
        val before = staged[id] ?: 0L
        io.execute {
            val result = try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val total = before + bytes.size
                if (total > FILE_MAX_BYTES) {
                    Result.failure(IllegalStateException(t("harmony.pageControl.tooBig")))
                } else {
                    FileOutputStream(File(stagingDir, "$id.part"), true).use { it.write(bytes) }
                    Result.success(total)
                }
            } catch (e: Exception) {
                Log.e(TAG, "write page file failed", e)
                Result.failure(IllegalStateException(t("harmony.pageControl.writeCacheFailed")))
            }
            main.post {
                result.fold({ total ->
                    staged[id] = total
                    reply(outcome(true, total.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), ""))
                }, { reply(outcome(false, 0, it.message ?: "")) })
            }
        }
    }

    /** 放掉预备好了没用上的文件：json 是文件编号的数组；不认得的编号跳过。回 {"ok", "count"（删了几个）} */
    fun discard(json: String): String {
        val ids = try {
            val parsed = JSONArray(json)
            List(parsed.length()) { parsed.opt(it) }.filterIsInstance<String>().filter { FILE_ID.matches(it) }
        } catch (_: Exception) {
            return outcome(false, 0, t("harmony.pageControl.badParams"))
        }
        var count = 0
        for (id in ids) {
            if (staged.remove(id) == null) continue
            File(stagingDir, "$id.part").delete()
            count += 1
        }
        return outcome(true, count, "")
    }

    private class DeliveryFile(val id: String, val name: String, val mime: String)

    /** 交文件（二狗的网页在面板上确认之后）：target 是 chooser 时交给拦下的选文件对话框；是 field 时一段一段交给页面桥、由它塞进那个选文件的框 */
    fun deliver(json: String, reply: (String) -> Unit) {
        val delivery = try {
            JSONObject(json)
        } catch (_: Exception) {
            reply(outcome(false, 0, t("harmony.pageControl.badParams")))
            return
        }
        val list = delivery.optJSONArray("files")
        if (list == null || list.length() == 0) {
            reply(outcome(false, 0, t("harmony.pageControl.noFiles")))
            return
        }
        val files = ArrayList<DeliveryFile>()
        for (i in 0 until list.length()) {
            val f = list.optJSONObject(i)
            val id = f?.opt("id") as? String
            if (id == null || !FILE_ID.matches(id) || !staged.containsKey(id)) {
                reply(outcome(false, 0, t("harmony.pageControl.notStaged")))
                return
            }
            files.add(DeliveryFile(id, f.optString("name"), f.optString("mime")))
        }
        val target = delivery.optString("target")
        val fieldId = delivery.opt("fieldId")
        when {
            target == "chooser" -> reply(deliverToChooser(files))
            target != "field" || fieldId !is String -> reply(outcome(false, 0, t("harmony.pageControl.badParams")))
            else -> deliverToField(fieldId, files, reply)
        }
    }

    private fun deliverToChooser(files: List<DeliveryFile>): String {
        val callback = chooser ?: return outcome(false, 0, t("harmony.pageControl.chooserClosed"))
        val uris = ArrayList<Uri>()
        for (f in if (chooserMultiple) files else files.take(1)) {
            // 改成原来的名字放在缓存里：网页看到的文件名是最后一段
            val dir = File(stagingDir, f.id).apply { mkdirs() }
            val path = File(dir, safeFileName(f.name))
            if (File(stagingDir, "${f.id}.part").renameTo(path)) {
                staged.remove(f.id)
                uris.add(Uri.fromFile(path))
            } else {
                Log.e(TAG, "stage chooser file failed")
            }
        }
        chooser = null
        callback.onReceiveValue(uris.toTypedArray())
        Log.i(TAG, "chooser got ${uris.size} files from ergo")
        return outcome(uris.isNotEmpty(), uris.size, if (uris.isNotEmpty()) "" else t("harmony.pageControl.filesNotReady"))
    }

    /** 一个一个文件、一段一段交给页面桥，最后 attachFiles；都等上一步回了再走下一步 */
    private fun deliverToField(fieldId: String, files: List<DeliveryFile>, reply: (String) -> Unit) {
        val ids = files.map { it.id }
        fun finish() {
            callPage("attachFiles", listOf(fieldId, JSONArray(ids).toString())) { result ->
                reply(result.ifEmpty { outcome(false, 0, t("harmony.pageControl.bridgeGone")) })
            }
        }
        fun sendFile(index: Int) {
            if (index >= files.size) {
                finish()
                return
            }
            val f = files[index]
            callPage("fileBegin", listOf(f.id, f.name, f.mime)) { began ->
                if (began.isEmpty()) {
                    reply(outcome(false, 0, t("harmony.pageControl.bridgeGone")))
                    return@callPage
                }
                sendChunks(f.id, { sendFile(index + 1) }, reply)
            }
        }
        sendFile(0)
    }

    /** 读一段（在 io 线程）、交给页面桥（在主线程）、等它回了再读下一段；读完删掉缓存里那份 */
    private fun sendChunks(id: String, next: () -> Unit, reply: (String) -> Unit) {
        val path = File(stagingDir, "$id.part")
        val stream = try {
            FileInputStream(path)
        } catch (e: Exception) {
            Log.e(TAG, "read page file failed", e)
            staged.remove(id)
            reply(outcome(false, 0, t("harmony.common.readCacheFailed")))
            return
        }
        val buffer = ByteArray(PAGE_CHUNK_BYTES)
        fun done() {
            stream.close()
            path.delete()
            staged.remove(id)
        }
        fun readNext() {
            io.execute {
                val read = try {
                    stream.read(buffer)
                } catch (e: Exception) {
                    Log.e(TAG, "read page file failed", e)
                    -2
                }
                val chunk = if (read > 0) Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP) else ""
                main.post {
                    when {
                        read == -2 -> {
                            done()
                            reply(outcome(false, 0, t("harmony.common.readCacheFailed")))
                        }
                        read <= 0 -> {
                            done()
                            next()
                        }
                        else -> callPage("fileChunk", listOf(id, chunk)) { readNext() }
                    }
                }
            }
        }
        readNext()
    }

    /**
     * 网页弹出选文件对话框（onShowFileChooser）：二狗的网页在、页面桥在时拦下来，问用户"让二狗选 / 自己选"（二狗的网页画面板）；
     * 不然直接用系统的选择器
     */
    fun intercept(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        // 上一个还没回的先当取消
        cancelChooser()
        chooser = callback
        chooserAt = System.currentTimeMillis()
        val accept = params.acceptTypes?.filter { it.isNotEmpty() } ?: emptyList()
        chooserAccept = accept
        chooserMultiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        chooserImages = accept.isNotEmpty() && accept.all { a ->
            a.startsWith("image/") || listOf(".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic").any { a.startsWith(it) }
        }
        if (!webReady() || !injected) {
            pickBySystem {}
            return true
        }
        // 页面桥 2 秒内说过是哪个框的才算（网站的脚本调 input.click() 的那一下）
        val fieldId = if (System.currentTimeMillis() - chooserFieldAt < CHOOSER_FIELD_MS) chooserField else ""
        emit(
            JSONObject()
                .put("type", "chooser")
                .put("accept", JSONArray(accept))
                .put("multiple", chooserMultiple)
                .put("capture", params.isCaptureEnabled)
                .put("fieldId", fieldId)
                .toString(),
        )
        return true
    }

    /** 面板上的选择：system 自己选（系统的选择器）、cancel 取消 */
    fun choose(choice: String, reply: (String) -> Unit) {
        if (chooser == null) {
            reply(outcome(false, 0, t("harmony.pageControl.chooserClosed")))
            return
        }
        when (choice) {
            "cancel" -> {
                // 气泡开着时用户又点了一次上传框：网页为旧气泡发的取消可能比新的对话框晚到，不能把新的关了（用户真要取消不会这么快）
                if (System.currentTimeMillis() - chooserAt >= CHOOSER_STALE_CANCEL_MS) cancelChooser()
                reply(outcome(true, 0, ""))
            }
            "system" -> pickBySystem(reply)
            else -> reply(outcome(false, 0, t("harmony.pageControl.unknownChoice")))
        }
    }

    private fun cancelChooser() {
        val callback = chooser
        chooser = null
        callback?.onReceiveValue(null)
    }

    /** 自己选：要图片的用图库选择器，别的用文件选择器；选好交给对话框，取消了也告诉它 */
    private fun pickBySystem(reply: (String) -> Unit) {
        picker.pick(chooserImages, chooserAccept, chooserMultiple) { uris ->
            val callback = chooser
            chooser = null
            callback?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            reply(outcome(uris.isNotEmpty(), uris.size, if (uris.isNotEmpty()) "" else t("harmony.pageControl.nothingPicked")))
        }
    }
}
