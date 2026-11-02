package com.catmaniii.ergo.browser

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.isWebUrl
import com.catmaniii.ergo.common.t
import com.catmaniii.ergo.common.withoutHash
import com.catmaniii.ergo.download.DownloadDivert
import com.catmaniii.ergo.download.DownloadRequest
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.Executors

/** 取多少（和协议的 MEDIA_TEXT_MAX_BYTES 一样，1 MB）；拦下载也只拦这么大以内、大小知道的 */
private const val TEXT_MAX = 1048576

/**
 * 只看扩展名时能渲染的（服务端一律当下载发的时候按它粗筛）：和网页一侧 packages/web/src/state/file-view.ts 的 EXTENSION_KIND、
 * 鸿蒙 browser/FileDocs.ets 的 RENDER_EXTENSIONS 一致（frontend/test/android.test.ts 核对）
 */
val RENDER_EXTENSIONS: List<String> = (
    "md markdown mdown mkd mkdn txt text log rst adoc org srt vtt json jsonc geojson webmanifest csv tsv tab " +
        "jsonl ndjson json5 js mjs cjs jsx ts tsx mts cts ets vue svelte css scss sass less py pyw rb go rs java kt kts scala groovy gradle swift m mm " +
        "c h cc cpp cxx hpp hh cs fs vb php pl pm lua r dart ex exs erl hs clj sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto " +
        "yaml yml toml ini cfg conf properties env diff patch tex bib cmake mk tf hcl nix zig sol"
    ).split(" ")

/** 网页、会跑脚本的扩展名：不拦 */
private val ACTIVE_EXTENSIONS = setOf("html", "htm", "xhtml", "shtml", "mht", "mhtml", "svg", "svgz", "xml", "xsl", "xslt", "rss", "atom")
/** 说不出是什么的类型：按扩展名 */
private val GENERIC_MIMES = setOf(
    "", "application/octet-stream", "binary/octet-stream", "application/x-download", "application/force-download",
    "application/download", "application/unknown", "application/x-unknown", "application/binary", "unknown/unknown",
)
/** 网页、流式的：不拦（+xml 结尾的也是） */
private val PAGE_MIMES = setOf("text/html", "text/xml", "text/event-stream")
/** 不是 text/ 开头、也算文本的 */
private val TEXT_LIKE_MIMES = setOf(
    "application/json", "text/json", "application/x-json", "application/x-ndjson", "application/ndjson",
    "application/jsonl", "application/javascript", "application/x-javascript", "application/ecmascript", "application/x-sh",
    "application/x-shellscript", "application/x-yaml", "application/yaml", "application/toml", "application/sql", "application/x-sql",
    "application/graphql", "application/csv", "application/x-csv",
)

/** 页面上显示的字：文本文档是 <body><pre>原文</pre></body>（JSON 新版还多一个格式化的框，取 pre 那份），取不到 pre 取整页的字 */
private const val SOURCE_SCRIPT =
    "(function(){var d=document,b=d.body,p=b?b.querySelector(':scope > pre'):null,n=p||b||d.documentElement," +
        "t=(n&&n.textContent)||'',m=$TEXT_MAX;return JSON.stringify({ok:true,kind:'text',mime:d.contentType||'',total:t.length," +
        "truncated:t.length>m,text:t.length>m?t.slice(0,m):t})})()"

private fun extensionOf(name: String): String {
    val dot = name.lastIndexOf('.')
    return if (dot > 0 && dot < name.length - 1) name.substring(dot + 1).lowercase() else ""
}

/** 地址最后一段（去掉查询串和 #） */
private fun lastSegment(url: String): String {
    val bare = url.replace(Regex("[?#].*$"), "")
    return bare.substringAfterLast('/')
}

private fun mimeOf(contentType: String): String = contentType.substringBefore(';').trim().lowercase()

/** 拦下载时先粗筛：可能是能渲染的文本才拦，最后由网页的 fileRenderOf 定——筛进来但网页说不渲染的，网页让 App 照常保存 */
fun looksText(name: String, url: String, contentType: String): Boolean {
    var ext = extensionOf(name)
    if (ext.isEmpty()) ext = extensionOf(lastSegment(url))
    if (ext in ACTIVE_EXTENSIONS) return false
    val mime = mimeOf(contentType)
    if (mime in GENERIC_MIMES) return ext in RENDER_EXTENSIONS
    if (mime in PAGE_MIMES || mime.endsWith("+xml")) return false
    return mime.startsWith("text/") || mime.endsWith("+json") || mime in TEXT_LIKE_MIMES
}

private fun outcome(ok: Boolean, reason: String): String = JSONObject().put("ok", ok).put("reason", reason).toString()

/**
 * 原生浏览器里能渲染的文件（对应鸿蒙 browser/FileDocs.ets）：markdown 这类文本文件交给二狗的网页用二狗的渲染画。网页说它能渲染文件了之后：
 * - 浏览器里每加载完一页，问一下它的 document.contentType，报给网页（document，via page）；取内容时现取页面上显示的字；
 * - 浏览器里的下载先粗筛（looksText，1 MB 以内、大小知道的），可能是能渲染的文本就拦下：照样下进 App 缓存，不提示、不弹"保存到"，
 *   报给网页（via download）；取内容时读缓存里那份的字节（base64）。同时只留一份，换成别的、网页说不看了（drop）就删；
 * - 下载（save）：页面上的重新下载一次（这次不拦），拦下的直接弹"保存到"；用系统浏览器打开（outside）这个文件的地址。
 * 编号 p…（页面）、d…（下载）由这里发，取内容、下载都凭它，过时的回明确的原因。
 */
class FileDocs(
    @Suppress("unused") private val context: Context,
    private val web: () -> WebView?,
    private val emit: (String) -> Unit,
    /** 缓存里的文件弹"保存到"（keep 为真时缓存里那份留着） */
    private val saveFile: (File, String, Boolean) -> Unit,
    /** 这个地址真的下载一次（这次不拦） */
    private val startDownload: (String) -> Unit,
    private val openOutside: (String) -> Unit,
) : DownloadDivert {
    /** 网页说它能渲染文件了（主页面重新加载时清掉，新页面再说） */
    var enabled = false
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var seq = 0
    /** 每开始加载一页加一：问类型问到一半换了页的不报 */
    private var pageToken = 0
    private class PageDoc(val id: String, val url: String)
    private class FileDoc(val id: String, val url: String, val name: String, val file: File)
    private var page: PageDoc? = null
    private var doc: FileDoc? = null
    /** 点了"下载"、要真的下载的地址（这次不拦） */
    private val forced = ArrayList<String>()
    private val diverted = HashSet<DownloadRequest>()

    fun pageBegin() {
        pageToken += 1
        page = null
    }

    /** 浏览器加载完一页：问它的类型，报给网页 */
    fun pageEnd(url: String?) {
        if (!enabled || url == null || !isWebUrl(url)) return
        val view = web() ?: return
        val token = pageToken
        view.evaluateJavascript("document.contentType") { result ->
            if (token != pageToken || !enabled) return@evaluateJavascript
            seq += 1
            val current = PageDoc("p$seq", url)
            page = current
            emit(docEvent(current.id, url, unquoteJs(result), "", "page", -1))
        }
    }

    private fun docEvent(id: String, url: String, mime: String, name: String, via: String, bytes: Long): String =
        JSONObject()
            .put("type", "document")
            .put("doc", JSONObject().put("id", id).put("url", url).put("mime", mime).put("name", name).put("via", via).put("bytes", bytes))
            .toString()

    /** 要不要拦这个下载：网页能渲染、不是点了"下载"的、1 MB 以内、粗看是文本 */
    override fun want(request: DownloadRequest, name: String): Boolean {
        if (forced.remove(request.url)) return false
        if (!enabled) return false
        val mine = request.length in 1..TEXT_MAX.toLong() && looksText(name, request.url, request.mime ?: "")
        if (mine) diverted.add(request)
        return mine
    }

    override fun isDiverted(request: DownloadRequest): Boolean = request in diverted

    /** 这个地址刚被拦下来，要在页面里渲染（不是真的存成文件） */
    fun showingDownload(url: String): Boolean = diverted.any { it.url == url }

    /** 拦下的下完了：换掉上一份，报给网页；网页这时已经不渲染了（重新加载过）就照常弹"保存到" */
    override fun finished(request: DownloadRequest, name: String, file: File) {
        diverted.remove(request)
        if (!enabled) {
            saveFile(file, name, false)
            return
        }
        dropFile()
        seq += 1
        val current = FileDoc("d$seq", request.url, name, file)
        doc = current
        emit(docEvent(current.id, current.url, request.mime ?: "", name, "download", request.length))
    }

    override fun failed(request: DownloadRequest) {
        diverted.remove(request)
        Log.w(TAG, "diverted download failed")
    }

    /** 网页调的（原生桥 browserDoc）：enable / source / save / outside / drop */
    fun run(op: String, id: String, reply: (String) -> Unit) {
        if (op == "enable") {
            enabled = true
            // 主页面重新加载过（网页重新说能渲染）：浏览器里现在这一页再报一次，显示着原始文本的照样盖上渲染层
            pageEnd(web()?.url)
            reply(outcome(true, ""))
            return
        }
        val currentPage = page?.takeIf { it.id == id }
        val currentFile = doc?.takeIf { it.id == id }
        if (currentPage == null && currentFile == null) {
            reply(outcome(false, t("harmony.fileDocs.fileGone")))
            return
        }
        when (op) {
            "source" -> if (currentPage != null) pageSource(currentPage, reply) else fileSource(currentFile!!, reply)
            "save" -> {
                if (currentFile != null) saveFile(currentFile.file, currentFile.name, true) else download(currentPage!!.url)
                reply(outcome(true, ""))
            }
            "outside" -> {
                openOutside(currentFile?.url ?: currentPage!!.url)
                reply(outcome(true, ""))
            }
            "drop" -> {
                if (currentFile != null) dropFile()
                reply(outcome(true, ""))
            }
            else -> reply(outcome(false, t("harmony.fileDocs.unknownOp")))
        }
    }

    /** 页面上显示的字（浏览器还在这一页才取） */
    private fun pageSource(current: PageDoc, reply: (String) -> Unit) {
        val view = web()
        if (view == null || withoutHash(view.url ?: "") != withoutHash(current.url)) {
            reply(outcome(false, t("harmony.fileDocs.pageChanged")))
            return
        }
        view.evaluateJavascript(SOURCE_SCRIPT) { result ->
            val json = unquoteJs(result)
            reply(json.ifEmpty { outcome(false, t("harmony.fileDocs.noPageText")) })
        }
    }

    /** 缓存里那份的字节（最多 1 MB，base64） */
    private fun fileSource(current: FileDoc, reply: (String) -> Unit) {
        io.execute {
            val json = try {
                val size = current.file.length()
                val length = minOf(size, TEXT_MAX.toLong()).toInt()
                val buffer = ByteArray(length)
                val read = FileInputStream(current.file).use { if (length > 0) it.read(buffer, 0, length) else 0 }.coerceAtLeast(0)
                JSONObject()
                    .put("ok", true)
                    .put("kind", "bytes")
                    .put("base64", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP))
                    .put("total", size)
                    .put("truncated", size > read)
                    .toString()
            } catch (e: Exception) {
                Log.e(TAG, "read diverted download failed", e)
                outcome(false, t("harmony.common.readCacheFailed"))
            }
            main.post { reply(json) }
        }
    }

    /** 页面上显示的文件真的下载一次（这次不拦，WebDownloads 照常弹"保存到"） */
    private fun download(url: String) {
        forced.add(url)
        if (forced.size > 5) forced.removeAt(0)
        startDownload(url)
    }

    /** 删掉缓存里拦下的那份 */
    private fun dropFile() {
        val current = doc ?: return
        doc = null
        current.file.delete()
    }
}
