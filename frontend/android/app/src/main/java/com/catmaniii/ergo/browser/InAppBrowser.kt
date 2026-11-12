package com.catmaniii.ergo.browser

import android.util.Log
import android.webkit.WebView
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.isWebUrl
import org.json.JSONObject

/** 网页报的内容区（JSON）；不对是 null。全部是 CSS 像素，乘 dpr 成物理像素（安卓的布局就用物理像素） */
class BrowserFrame(val visible: Boolean, val x: Int, val y: Int, val width: Int, val height: Int)

private fun finite(value: Any?): Double? = (value as? Number)?.toDouble()?.takeIf { it.isFinite() }

fun parseFrame(json: String): BrowserFrame? {
    val value = try {
        JSONObject(json)
    } catch (_: Exception) {
        return null
    }
    val dpr = finite(value.opt("dpr")) ?: return null
    if (dpr <= 0) return null
    return frameOf(value, dpr)
}

/** 一个矩形（x、y、width、height、visible）换成物理像素 */
fun frameOf(value: JSONObject, dpr: Double): BrowserFrame? {
    val x = finite(value.opt("x")) ?: return null
    val y = finite(value.opt("y")) ?: return null
    val width = finite(value.opt("width")) ?: return null
    val height = finite(value.opt("height")) ?: return null
    val w = Math.round(width * dpr).toInt()
    val h = Math.round(height * dpr).toInt()
    return BrowserFrame(value.optBoolean("visible") && w > 0 && h > 0, Math.round(x * dpr).toInt(), Math.round(y * dpr).toInt(), w, h)
}

/**
 * 一页"加载完了"（onPageFinished）之后浏览器开着哪一页：只认 WebView 历史里当前那一条（committed）。
 * 一次跳转变成下载时没有新的一页，WebView 还是会报一次加载完、带着下载地址：不认它，回还开着的那一页，一页都没有是空串
 * （不然下载地址进了"最近访问"、地址栏也写着它，票 386）。报的不是网址（about:blank 这些）照旧不动，回 current
 */
fun pageAfterLoad(reported: String?, committed: String?, current: String): String = when {
    reported == null || !isWebUrl(reported) -> current
    committed != null && isWebUrl(committed) -> committed
    else -> ""
}

/**
 * 原生的内置浏览器（对应鸿蒙 browser/InAppBrowser.ets，"浏览"页签）：另一个 WebView，叠在二狗的网页上面、盖住"浏览"页签的内容区
 * （位置大小由网页经原生桥 browserLayout 报来，MainActivity 摆）。这里是它的状态和动作。
 * - 不挂二狗的原生桥：外部网页拿不到二狗的任何原生能力；
 * - 只开 http、https；别的协议（tel:、mailto:、App 跳转）交给系统；
 * - 切到别的页签只是藏起来，切回来页面原样还在；换二狗的地址也不重建。
 */
class InAppBrowser(
    /** 往二狗的网页推（window.__ergoBrowser） */
    private val emit: (String) -> Unit,
    /** 现在的样子变了（写进原生桥的镜像值：网页同步调 browserAttach 时读它） */
    private val stateChanged: (String) -> Unit,
    /** 建 WebView（第一次 attach 或要开地址时才建，之后一直留着） */
    private val create: () -> WebView,
) {
    /** 二狗的网页有"浏览"页签（调过 browserAttach）：主页面上点的外链改到这里打开；主页面重新加载、换地址时清掉，等新页面再说 */
    var attached = false
    var web: WebView? = null
        private set
    private var url = ""
    private var title = ""
    private var progress = 0
    private var loading = false

    /** 现在的样子 {"url", "title", "progress", "loading", "canGoBack", "canGoForward"} */
    fun stateJson(): String = state().toString()

    private fun state(): JSONObject = JSONObject()
        .put("url", url)
        .put("title", title)
        .put("progress", progress)
        .put("loading", loading)
        .put("canGoBack", web?.canGoBack() == true)
        .put("canGoForward", web?.canGoForward() == true)

    /** 网页有"浏览"页签了：建 WebView（之后一直留着） */
    fun attach() {
        attached = true
        ensureCreated()
        pushState()
    }

    /** 打开一个网址：只认 http、https */
    fun load(target: String): Boolean {
        if (!isWebUrl(target)) {
            Log.w(TAG, "browser refused to load a non-web url")
            return false
        }
        ensureCreated()
        // 点了打开马上算在加载（网页的进度条先出来），页面真开始了 onPageStarted 再更新地址
        url = target
        loading = true
        progress = 0
        web?.loadUrl(target)
        pushState()
        return true
    }

    /** 顶栏的几个动作（outside 由 MainActivity 交给系统浏览器，这里不管） */
    fun nav(action: String) {
        val view = web ?: return
        when (action) {
            "back" -> if (view.canGoBack()) view.goBack()
            "forward" -> if (view.canGoForward()) view.goForward()
            "reload" -> view.reload()
            "stop" -> {
                view.stopLoading()
                loading = false
                pushState()
            }
        }
    }

    /** 返回手势：网页还有历史就退一页，返回 true；没有了返回 false（照二狗别的页签的规矩） */
    fun backGesture(): Boolean {
        val view = web ?: return false
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    /** 现在这一页的地址（"用系统浏览器打开"用）；还没开过是空串 */
    fun currentUrl(): String {
        val now = web?.url ?: ""
        return if (isWebUrl(now)) now else url
    }

    fun pageBegin(address: String?) {
        if (address != null && isWebUrl(address)) url = address
        loading = true
        pushState()
    }

    /**
     * 这次跳转是个下载，不会有新的一页：不再算加载中，地址回到还开着的那一页。
     * 一页都没开过（打开的第一个地址就是下载）时地址清空，网页换回空的"浏览"页、把 WebView 藏起来：
     * 一页都没有的 WebView 露在外面时整个窗口都是黑的，顶栏和页签也看不见
     */
    fun downloadStarted() {
        val open = web?.copyBackForwardList()?.currentItem?.url
        url = if (open != null && isWebUrl(open)) open else ""
        if (url.isEmpty()) {
            title = ""
            progress = 0
        }
        loading = false
        pushState()
    }

    fun pageEnd(address: String?) {
        url = pageAfterLoad(address, web?.copyBackForwardList()?.currentItem?.url, url)
        loading = false
        if (url.isEmpty()) {
            // 打开的第一个地址就是下载：回到空的"浏览"页（同 downloadStarted）
            title = ""
            progress = 0
        } else {
            progress = 100
            val now = web?.title ?: ""
            if (now.isNotEmpty() && !isWebUrl(now)) title = now
        }
        pushState()
    }

    fun progressChanged(value: Int) {
        progress = value
        pushState()
    }

    fun titleReceived(value: String?) {
        // 没有 <title> 时 WebView 报的是地址：不当标题
        val text = value ?: ""
        title = if (isWebUrl(text)) "" else text
        pushState()
    }

    /** 网页历史变了（后退前进亮不亮跟着变） */
    fun historyChanged(address: String?) {
        if (address != null && isWebUrl(address)) url = address
        pushState()
    }

    /** 推一条 {type: "open", url}：网页切到"浏览" */
    fun pushOpened(address: String) {
        emit(JSONObject().put("type", "open").put("url", address).toString())
    }

    private fun pushState() {
        val current = state()
        stateChanged(current.toString())
        emit(JSONObject().put("type", "state").put("state", current).toString())
    }

    private fun ensureCreated() {
        if (web == null) web = create()
    }
}
