package com.catmaniii.ergo.browser

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import com.catmaniii.ergo.common.ServerAddress
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.isWebUrl
import com.catmaniii.ergo.common.originOf
import com.catmaniii.ergo.common.t
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 文字大小（百分比）：和网页一侧 packages/web/src/state/browse-tools.ts 的 TEXT_ZOOM 一致 */
private const val ZOOM_NORMAL = 100
private const val ZOOM_MIN = 50
private const val ZOOM_MAX = 200
/** 下载记录存在 App 的文件目录里（不进缓存：清缓存不清它），最多记这么多条 */
private const val DOWNLOADS_FILE = "browser-downloads.json"
private const val DOWNLOADS_MAX = 200
/** 清 Cookie 时留下的二狗自己的 cookie 再写回去时的有效期（秒）：和守护进程的设备凭证一样 400 天（每次用都会重新下发） */
private const val OWN_COOKIE_MAX_AGE = 34560000
/** 主机名像样：字母数字、点、横线（IPv6 带方括号） */
private val HOST = Regex("^(\\[[0-9a-f:.]+]|[a-z0-9.-]{1,253})$")
/** 二狗的网页交来的浏览器标识只认这样的（Mozilla/5.0 开头、不太长） */
private val USER_AGENT = Regex("^Mozilla/5\\.0 [\\x20-\\x7e]{10,400}$")

private fun outcome(ok: Boolean, reason: String): String {
    val json = JSONObject().put("ok", ok)
    if (reason.isNotEmpty()) json.put("reason", reason)
    return json.toString()
}

/** http(s) 地址的主机名（小写，去掉用户名和端口）；不是 http(s) 是空串 */
fun hostOf(url: String): String {
    val match = Regex("^https?://([^/?#]*)", RegexOption.IGNORE_CASE).find(url) ?: return ""
    val authority = match.groupValues[1].substringAfterLast('@')
    val host = (if (authority.startsWith("[")) authority.substring(0, authority.indexOf(']') + 1) else authority.replace(Regex(":\\d*$"), "")).lowercase()
    return if (HOST.matches(host)) host else ""
}

/** 清一个网站的 cookie 时试的 Domain：不写、主机名、带点的主机名、各级上级域名（IP 不试上级） */
fun cookieDomains(host: String): List<String> {
    val out = mutableListOf("", "; Domain=$host", "; Domain=.$host")
    if (Regex("^[0-9.]+$").matches(host) || host.startsWith("[")) return out
    val labels = host.split('.')
    for (i in 1 until labels.size - 1) {
        val parent = labels.drop(i).joinToString(".")
        out.add("; Domain=$parent")
        out.add("; Domain=.$parent")
    }
    return out
}

/** 清一个网站的 cookie 时试的 Path：/ 和地址里每一级（最多 5 级） */
fun cookiePaths(url: String): List<String> {
    val path = Regex("^https?://[^/?#]*(/[^?#]*)?", RegexOption.IGNORE_CASE).find(url)?.groupValues?.get(1)?.ifEmpty { "/" } ?: "/"
    val out = mutableListOf("/")
    var at = ""
    for (part in path.split('/').filter { it.isNotEmpty() }.take(5)) {
        at = "$at/$part"
        out.add(at)
    }
    return out
}

/** "a=1; b=2" 里的名字和值 */
fun cookiePairs(raw: String?): List<Pair<String, String>> = (raw ?: "").split(';').mapNotNull { piece ->
    val eq = piece.indexOf('=')
    val name = (if (eq >= 0) piece.substring(0, eq) else piece).trim()
    if (name.isEmpty()) null else name to (if (eq >= 0) piece.substring(eq + 1).trim() else "")
}

/**
 * "浏览"页签右上角 ⋮ 菜单（对应鸿蒙 browser/BrowserTools.ets，165 号票）用到的原生能力，二狗的网页经原生桥 browserTool(op, json) 调，都回 JSON：
 * - find / findNext / findClear：WebView 自带的页内查找，结果经 searchResult 推 {type: "find"}；findBar 是网页的查找栏开没开——开着时返回手势先收起它；
 * - sites：按网站记住的文字大小、桌面版（记在二狗网页那边，整份交过来）。文字大小在每一页开始时设；桌面版换浏览器标识，只给内置浏览器这一个 WebView，
 *   二狗的网页不受影响（鸿蒙的 setUserAgentForHosts 对整个 App 生效，要排除二狗自己的主机名，这里同样排除，免得内置浏览器开二狗页面时换标识）；
 * - share：系统分享面板；
 * - clear：清缓存（整个 App 一份，没法只清一个网站）、Cookie 和网站数据。cookie 整个 App 共用一份，二狗自己的设备凭证也在里面：
 *   清全部时先取二狗来源的 cookie，清完写回去（HttpOnly、Secure、SameSite=Strict、Path=/，不削弱），网页存储按来源删、跳过二狗的来源；
 *   只清当前网站时把这个地址带着的 cookie 按几种 Domain、Path 写成过期，二狗自己的页面不清 cookie（清了二狗会掉线）；
 * - downloads / openDownload / removeDownloads：下载记录，打开交给系统（带读权限），删记录不删文件。
 */
class BrowserTools(
    private val context: Context,
    private val web: () -> WebView?,
    private val emit: (String) -> Unit,
    private val server: () -> ServerAddress?,
    private val currentUrl: () -> String,
) {
    private var zoomByHost: Map<String, Int> = emptyMap()
    private var desktopUa = ""
    private var desktopHosts: Set<String> = emptySet()
    private var defaultUa: String? = null
    /** 网页的查找栏开着 */
    var findOpen = false
    private var downloadList: List<JSONObject> = emptyList()
    private var downloadsLoaded = false
    private var downloadSeq = 0
    private val cookies get() = CookieManager.getInstance()

    /** browserTool(op, json)：回 JSON */
    fun run(op: String, json: String, reply: (String) -> Unit) {
        val args = try {
            JSONObject(json)
        } catch (_: Exception) {
            JSONObject()
        }
        when (op) {
            "find" -> reply(find(args.opt("text") as? String ?: ""))
            "findNext" -> {
                val view = web()
                if (view == null) reply(outcome(false, t("harmony.browserTools.notReady"))) else {
                    view.findNext(args.opt("forward") != false)
                    reply(outcome(true, ""))
                }
            }
            "findClear" -> {
                web()?.clearMatches()
                reply(outcome(true, ""))
            }
            "findBar" -> {
                findOpen = args.opt("open") == true
                reply(outcome(true, ""))
            }
            "sites" -> reply(sites(args))
            "share" -> reply(share(args.opt("title") as? String ?: "", args.opt("url") as? String ?: ""))
            "clear" -> clear(args, reply)
            "downloads" -> reply(JSONObject().put("ok", true).put("downloads", JSONArray(loadDownloads())).toString())
            "openDownload" -> reply(openDownload(args.opt("id") as? String ?: ""))
            "removeDownloads" -> reply(removeDownloads(args.optJSONArray("ids")))
            else -> reply(outcome(false, t("harmony.browserTools.unknownOp", mapOf("op" to op))))
        }
    }

    // ───────────────────────── 页内查找 ─────────────────────────

    private fun find(text: String): String {
        val view = web() ?: return outcome(false, t("harmony.browserTools.notReady"))
        if (text.isEmpty()) {
            view.clearMatches()
            emit(findMessage(0, 0, true))
            return outcome(true, "")
        }
        view.findAllAsync(text.take(200))
        return outcome(true, "")
    }

    private fun findMessage(active: Int, total: Int, done: Boolean) = JSONObject().put("type", "find").put("active", active).put("total", total).put("done", done).toString()

    /** WebView 的 FindListener：推给网页（activeMatchOrdinal 从 0 数） */
    fun searchResult(active: Int, total: Int, done: Boolean) {
        if (findOpen) emit(findMessage(maxOf(0, active), maxOf(0, total), done))
    }

    /** 返回手势：查找栏开着就让网页收起它，返回 true */
    fun closeFind(): Boolean {
        if (!findOpen) return false
        findOpen = false
        emit(JSONObject().put("type", "find-close").toString())
        return true
    }

    // ───────────────────────── 按网站记住的文字大小、桌面版 ─────────────────────────

    private fun sites(args: JSONObject): String {
        val zoom = HashMap<String, Int>()
        args.optJSONObject("zoom")?.let { given ->
            for (host in given.keys()) {
                val value = given.opt(host)
                if (HOST.matches(host) && value is Number && value.toDouble().isFinite()) {
                    zoom[host] = Math.round(value.toDouble()).toInt().coerceIn(ZOOM_MIN, ZOOM_MAX)
                }
            }
        }
        zoomByHost = zoom
        val own = server()?.host?.lowercase() ?: ""
        val list = args.optJSONArray("desktop")
        val hosts = HashSet<String>()
        if (list != null) {
            for (i in 0 until minOf(list.length(), 1000)) {
                val h = list.opt(i)
                if (h is String && HOST.matches(h) && h != own) hosts.add(h)
            }
        }
        desktopHosts = hosts
        val ua = args.opt("desktopUserAgent") as? String ?: ""
        desktopUa = if (USER_AGENT.matches(ua)) ua else ""
        // 现在这一页的文字大小、浏览器标识跟着变（桌面版切换后网页自己重新加载）
        pageBegin(currentUrl())
        applyUserAgent(currentUrl())
        return outcome(true, "")
    }

    /** 这个地址该用的浏览器标识换上：变了回 true（要跳转的话调用方重新发起一次，新标识才生效） */
    fun applyUserAgent(url: String): Boolean {
        val view = web() ?: return false
        val settings = view.settings
        val default = defaultUa ?: settings.userAgentString.also { defaultUa = it }
        val want = if (desktopUa.isNotEmpty() && hostOf(url) in desktopHosts) desktopUa else default
        if (settings.userAgentString == want) return false
        settings.userAgentString = want
        return true
    }

    /** 浏览器里一页开始了、按网站的设置变了：按这一页的主机名设文字大小 */
    fun pageBegin(url: String?) {
        web()?.settings?.textZoom = zoomByHost[hostOf(url ?: "")] ?: ZOOM_NORMAL
    }

    // ───────────────────────── 分享 ─────────────────────────

    private fun share(title: String, url: String): String {
        if (!isWebUrl(url)) return outcome(false, t("harmony.browserTools.shareWebOnly"))
        return try {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
            if (title.isNotEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title.take(300))
            context.startActivity(Intent.createChooser(send, title.take(300).ifEmpty { url }))
            outcome(true, "")
        } catch (e: Exception) {
            Log.e(TAG, "share failed", e)
            outcome(false, t("harmony.browserTools.shareUnsupported"))
        }
    }

    // ───────────────────────── 清除浏览数据 ─────────────────────────

    private fun clear(args: JSONObject, reply: (String) -> Unit) {
        val notes = JSONArray()
        val url = args.opt("url") as? String ?: ""
        val site = args.opt("scope") == "site" && isWebUrl(url)
        if (args.opt("cache") == true) {
            // 缓存整个 App 一份：二狗的网页是守护进程现给的，清了只是下次重新取
            web()?.clearCache(true)
            if (site) notes.put(t("harmony.browserTools.cacheAllSites"))
        }
        val finish = { ok: Boolean, reason: String ->
            val result = JSONObject().put("ok", ok).put("notes", notes)
            if (reason.isNotEmpty()) result.put("reason", reason)
            cookies.flush()
            reply(result.toString())
        }
        if (args.opt("cookies") != true) {
            finish(true, "")
        } else if (site) {
            clearSite(url, notes)
            finish(true, "")
        } else {
            clearAll(notes, finish)
        }
    }

    /** 全部网站的 Cookie 和网站数据：二狗自己的留着 */
    private fun clearAll(notes: JSONArray, finish: (Boolean, String) -> Unit) {
        val address = server()
        val kept = if (address == null) null else cookies.getCookie(address.href)
        cookies.removeAllCookies { removed ->
            if (address != null && !kept.isNullOrEmpty()) restoreOwn(address, kept, notes)
            clearStorage(address)
            Log.i(TAG, "cookies cleared: $removed")
            finish(true, "")
        }
    }

    private fun clearStorage(address: ServerAddress?) {
        WebStorage.getInstance().getOrigins { origins ->
            val map = origins as? Map<*, *> ?: return@getOrigins
            for (origin in map.keys.filterIsInstance<String>()) {
                if (address != null && originOf(origin) == address.origin) continue
                WebStorage.getInstance().deleteOrigin(origin)
            }
        }
    }

    /** 清全部 cookie 之后把二狗来源的写回去（设备凭证是 HttpOnly、Secure、SameSite=Strict、Path=/ 的 __Host- cookie），再核对一遍 */
    private fun restoreOwn(address: ServerAddress, kept: String, notes: JSONArray) {
        val pairs = cookiePairs(kept)
        for ((name, value) in pairs) {
            val secure = address.scheme == "https" || name.startsWith("__Host-") || name.startsWith("__Secure-")
            // 本机调试的 http 地址：系统不许在 http 地址上写 Secure 的 cookie（targetSdk 29 起），换成 https 写；属性一个不削弱，本机地址照样读得到
            val target = if (secure && address.scheme == "http") address.href.replaceFirst("http://", "https://") else address.href
            cookies.setCookie(target, "$name=$value; Max-Age=$OWN_COOKIE_MAX_AGE; Path=/; HttpOnly${if (secure) "; Secure" else ""}; SameSite=Strict")
        }
        val now = cookiePairs(cookies.getCookie(address.href)).map { it.first }
        val lost = pairs.count { it.first !in now }
        if (lost > 0) {
            Log.e(TAG, "own cookies lost after clearing: $lost")
            notes.put(t("harmony.browserTools.ownLoginLost"))
        } else {
            Log.i(TAG, "kept ${pairs.size} own cookies while clearing")
        }
    }

    /** 只清当前网站：这个地址带着的 cookie 按几种 Domain、Path 写成过期，再删这个来源的网页存储；二狗自己的页面不清 cookie */
    private fun clearSite(url: String, notes: JSONArray) {
        if (originOf(url) == server()?.origin) {
            notes.put(t("harmony.browserTools.ownSiteKept"))
            return
        }
        val host = hostOf(url)
        val secure = if (url.lowercase().startsWith("https:")) "; Secure" else ""
        for ((name, _) in cookiePairs(cookies.getCookie(url))) {
            val hostOnly = name.startsWith("__Host-")
            for (domain in if (hostOnly) listOf("") else cookieDomains(host)) {
                for (path in if (hostOnly) listOf("/") else cookiePaths(url)) {
                    cookies.setCookie(url, "$name=; Max-Age=0; Path=$path$domain$secure")
                }
            }
        }
        val left = cookiePairs(cookies.getCookie(url)).size
        if (left > 0) notes.put(t("harmony.browserTools.cookiesLeft", mapOf("count" to left.toString())))
        WebStorage.getInstance().deleteOrigin(originOf(url))
    }

    // ───────────────────────── 下载记录 ─────────────────────────

    private val downloadsPath get() = File(context.filesDir, DOWNLOADS_FILE)

    private fun loadDownloads(): List<JSONObject> {
        if (downloadsLoaded) return downloadList
        downloadsLoaded = true
        try {
            if (downloadsPath.exists()) {
                val array = JSONArray(downloadsPath.readText())
                downloadList = List(array.length()) { array.optJSONObject(it) }
                    .filterNotNull()
                    .filter { it.opt("id") is String && it.opt("uri") is String }
                    .take(DOWNLOADS_MAX)
            }
        } catch (e: Exception) {
            Log.w(TAG, "read download records failed", e)
        }
        return downloadList
    }

    private fun saveDownloads() {
        try {
            downloadsPath.writeText(JSONArray(downloadList).toString())
        } catch (e: Exception) {
            Log.w(TAG, "write download records failed", e)
        }
    }

    /** 浏览器里下载的文件存好了（WebDownloads 弹"保存到"、拷过去之后）：记一条 */
    fun record(name: String, uri: String, size: Long, mime: String) {
        val list = loadDownloads()
        downloadSeq += 1
        val now = System.currentTimeMillis()
        val entry = JSONObject().put("id", "dl-$now-$downloadSeq").put("name", name).put("size", size).put("time", now).put("uri", uri).put("mime", mime)
        downloadList = (listOf(entry) + list).take(DOWNLOADS_MAX)
        saveDownloads()
    }

    /** 打开一个下载的文件：交给系统（带读权限）；系统没有能打开它的应用、文件被移走或删了时回原因 */
    private fun openDownload(id: String): String {
        val entry = loadDownloads().firstOrNull { it.optString("id") == id } ?: return outcome(false, t("harmony.browserTools.recordGone"))
        return try {
            val uri = Uri.parse(entry.optString("uri"))
            val mime = entry.optString("mime")
            val intent = Intent(Intent.ACTION_VIEW).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (mime.isNotEmpty()) intent.setDataAndType(uri, mime) else intent.data = uri
            context.startActivity(intent)
            outcome(true, "")
        } catch (e: android.content.ActivityNotFoundException) {
            Log.w(TAG, "open download failed", e)
            outcome(false, t("harmony.browserTools.noAppToOpen"))
        } catch (e: Exception) {
            Log.w(TAG, "open download failed", e)
            outcome(false, t("harmony.browserTools.cantOpenFile"))
        }
    }

    /** 删记录（文件留着） */
    private fun removeDownloads(ids: JSONArray?): String {
        val gone = HashSet<String>()
        if (ids != null) for (i in 0 until ids.length()) (ids.opt(i) as? String)?.let { gone.add(it) }
        downloadList = loadDownloads().filter { it.optString("id") !in gone }
        saveDownloads()
        return outcome(true, "")
    }
}
