package com.catmaniii.ergo.bridge

import android.net.Uri
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.catmaniii.ergo.common.TAG
import org.json.JSONArray
import org.json.JSONObject

/** 网页里看到的通道对象名：只有配好的二狗来源的框架里才有（addWebMessageListener 的来源白名单） */
const val CHANNEL_NAME = "__ergoChannel"
/** 垫片里 App 注入前要换掉的那一处 */
private const val BOOT_MARK = "/*__ERGO_BOOT__*/ null"
private const val SHIM_FILE = "ergo-native-shim.js"

/** 系统的 WebView 够新吗：原生桥只走这两个带来源白名单的接口，不够新就不开（不退回 addJavascriptInterface） */
fun webViewSupportsBridge(): Boolean =
    WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

/** 网页调过来的一次 */
class BridgeCall(val method: String, private val args: JSONArray, private val id: Int?, private val channel: BridgeChannel) {
    fun string(index: Int): String = args.opt(index) as? String ?: ""
    fun bool(index: Int): Boolean = args.opt(index) == true

    /** 回 Promise 的方法的结果 */
    fun reply(value: String) {
        if (id != null) channel.reply(id, value)
    }
}

/**
 * 原生桥的通道（安全要求见 docs/architecture/adr/0040）：一个 WebView 一份，只认一个来源。
 * - addWebMessageListener 带来源白名单：别的来源的页面、iframe 里根本没有通道对象；
 * - addDocumentStartJavaScript 带同一个白名单：垫片（assets/ergo-native-shim.js）只进二狗的页面，在网页的脚本之前；
 * - 每条消息再核对一遍：来源是配好的、发信的是主框架（对应鸿蒙 NativeBridge 的 allowed()）。同来源的 iframe（比如二狗转发的服务页面、
 *   HTML 附件预览）也有通道对象，靠 isMainFrame 拒掉；
 * - 回信走 JavaScriptReplyProxy：只送回发信的那个框架，页面跳走了就丢掉，不会把消息推给别的页面。
 */
class BridgeChannel(
    private val webView: WebView,
    /** 配好的来源，scheme://host[:port] */
    private val origin: String,
    private val methods: BridgeMethods,
    private val isSide: Boolean,
    private val version: String,
    /** 现在的镜像值（safeArea、notify、open、browser）：写进垫片、新页面起来时再推一次 */
    private val mirror: () -> JSONObject,
    private val onCall: (BridgeCall) -> Unit,
    private val onContact: () -> Unit,
) {
    private var proxy: JavaScriptReplyProxy? = null
    private var script: ScriptHandler? = null
    private val shim: String = webView.context.assets.open(SHIM_FILE).bufferedReader(Charsets.UTF_8).use { it.readText() }

    fun install() {
        WebViewCompat.addWebMessageListener(webView, CHANNEL_NAME, setOf(origin)) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            received(message, sourceOrigin, isMainFrame, replyProxy)
        }
        refreshScript()
    }

    /** 垫片换上现在的镜像值：下一次加载就是新的；已经开着的页面靠 push 更新 */
    fun refreshScript() {
        script?.remove()
        val boot = JSONObject()
            .put("version", version)
            .put("side", isSide)
            .put("methods", JSONObject().put("mirror", JSONArray(methods.mirror)).put("fire", JSONArray(methods.fire)).put("promise", JSONArray(methods.promise)))
            .put("mirror", mirror())
        check(shim.contains(BOOT_MARK)) { "$SHIM_FILE has no boot mark" }
        script = WebViewCompat.addDocumentStartJavaScript(webView, shim.replace(BOOT_MARK, boot.toString()), setOf(origin))
    }

    private fun received(message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        val source = sourceOrigin.toString().trimEnd('/')
        if (source != origin || !isMainFrame) {
            // 白名单已经挡住了别的来源：走到这里只可能是同来源的 iframe
            Log.w(TAG, "bridge refused: from $source, main frame $isMainFrame, expected $origin")
            return
        }
        val call = try {
            val json = JSONObject(message.data ?: return)
            BridgeCall(json.getString("m"), json.optJSONArray("a") ?: JSONArray(), if (json.has("id")) json.getInt("id") else null, this)
        } catch (e: Exception) {
            Log.w(TAG, "bridge message ignored: bad shape", e)
            return
        }
        proxy = replyProxy
        when (call.method) {
            "__hello" -> pushMirror()
            "__contact" -> onContact()
            else -> if (call.method in methods.all) onCall(call) else Log.w(TAG, "bridge method not open here: ${call.method}")
        }
    }

    /** 开着的页面上的镜像值全部再推一次 */
    private fun pushMirror() {
        val values = mirror()
        for (key in values.keys()) setMirror(key, values.optString(key))
    }

    /**
     * 发给最近一个说过话的页面。新页面开场会说 __hello，回信通道就换成它的、镜像值再推一次；旧页面的通道发过去系统直接丢掉。
     * 不在 onPageStarted 里清通道：新页面的 __hello 可能比 onPageStarted 先到，清了反而把新通道丢了
     */
    private fun send(message: JSONObject) {
        val target = proxy ?: return
        try {
            target.postMessage(message.toString())
        } catch (e: Exception) {
            Log.w(TAG, "bridge push failed", e)
        }
    }

    fun reply(id: Int, value: String) = send(JSONObject().put("t", "r").put("id", id).put("v", value))

    /** 更新页面里记着的值 */
    fun setMirror(key: String, value: String) = send(JSONObject().put("t", "m").put("k", key).put("v", value))

    /** 调网页登记的函数（__ergoVoice 这些，垫片里有名单）；arg 是 null 时不带参数 */
    fun callPage(function: String, arg: String? = null) {
        val message = JSONObject().put("t", "c").put("f", function)
        if (arg != null) message.put("a", arg)
        send(message)
    }
}

/** 一个 WebView 上开哪些方法 */
class BridgeMethods(val mirror: List<String>, val fire: List<String>, val promise: List<String>, extra: List<String> = emptyList()) {
    val all: Set<String> = (mirror + fire + promise + extra).toSet()
}
