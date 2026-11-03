package com.catmaniii.ergo.bridge

import android.util.Log
import com.catmaniii.ergo.common.AppTexts
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.voice.NativeVoice

/**
 * 主界面那个 WebView 上开的方法（对应鸿蒙 bridge/NativeBridge.ets 的 NATIVE_BRIDGE_METHODS，名字以网页一侧 packages/web/src/app/native*.ts 为准，
 * frontend/test/android.test.ts 核对）。第一版不开手机数据源（phone*）：网页认不出这一组，那些功能自然不出现。
 * 分三种，因为通道只能发消息、不能同步回值（见 BridgeChannel）：
 * - mirror：网页要同步拿值的，读垫片里记着的那一份；
 * - fire：不要结果；
 * - promise：回 Promise<string>。
 */
val NATIVE_BRIDGE_MIRROR_METHODS = listOf("appVersion", "safeArea", "setTexts", "browserAttach", "notifyState", "notifyTakeOpen", "notifyResetAsked")
val NATIVE_BRIDGE_FIRE_METHODS = listOf("log", "editServer", "setColorMode", "setCanGoBack", "voiceDiscard", "voiceRelease", "browserLayout", "browserLoad", "browserNav", "browserSide")
val NATIVE_BRIDGE_PROMISE_METHODS = listOf(
    "voicePrepare", "voiceStart", "voiceStop",
    "notifyPrepare", "notifyShow",
    "browserPage", "browserFileChunk", "browserFiles", "browserChooser", "browserDiscard", "browserDoc", "browserTool",
    // 在 App 里更新 App（票 399）：只有安卓有、只开给主界面（侧边栏那份没有）
    "installAppUpdate",
)

val MAIN_METHODS = BridgeMethods(NATIVE_BRIDGE_MIRROR_METHODS, NATIVE_BRIDGE_FIRE_METHODS, NATIVE_BRIDGE_PROMISE_METHODS)

/**
 * 浏览侧边栏那个 WebView 上的原生桥（对应鸿蒙的 NATIVE_SIDE_BRIDGE_METHODS）：同一个 NativeBridge 类、自己一份原生录音器，
 * 只开版本号（网页据此认出在 App 里）、日志和录音那一组。地址页、外观、返回键、底部避让、通知、内置浏览器这些只归主界面那个 WebView
 */
val NATIVE_SIDE_MIRROR_METHODS = listOf("appVersion")
val NATIVE_SIDE_FIRE_METHODS = listOf("log", "voiceDiscard", "voiceRelease")
val NATIVE_SIDE_PROMISE_METHODS = listOf("voicePrepare", "voiceStart", "voiceStop")

/** 侧边栏的网页能调的 window.ergoSide（收起、取消选中、起来了），垫片经通道发过来 */
val SIDE_HOST_MESSAGES = listOf("side.close", "side.clearSelection", "side.ready")

val SIDE_METHODS = BridgeMethods(NATIVE_SIDE_MIRROR_METHODS, NATIVE_SIDE_FIRE_METHODS, NATIVE_SIDE_PROMISE_METHODS, SIDE_HOST_MESSAGES)

/** MainActivity 给原生桥的 */
interface BridgeHost {
    fun editServer()
    fun colorModeChanged(mode: String)

    /** 系统通知：取走了用户点开的那一条（垫片带上是哪一条） */
    fun notifyTaken(value: String)
    fun notifyResetAsked()
    fun notifyPrepare(userAction: Boolean, reply: (String) -> Unit)
    fun notifyShow(id: String, title: String, body: String, route: String, force: Boolean, reply: (String) -> Unit)

    /** 原生的内置浏览器：网页有"浏览"页签了 */
    fun browserAttach()
    /** 内容区的位置大小（JSON：CSS 像素、devicePixelRatio、要不要显示） */
    fun browserLayout(json: String)
    /** 开一个网址（只认 http、https） */
    fun browserLoad(url: String)
    /** back / forward / reload / stop / outside */
    fun browserNav(action: String)
    /** 浏览侧边栏：侧边栏摆在哪（JSON：CSS 像素、devicePixelRatio、要不要显示）、交给侧边栏网页的样子 */
    fun browserSide(json: String)
    /** 侧边栏的网页调的 window.ergoSide：close、clearSelection、ready */
    fun sideAction(action: String)
    /** 调页面桥，args 是参数的 JSON 数组 */
    fun browserPage(op: String, args: String, reply: (String) -> Unit)
    /** 要交的文件的一段（base64）写进 App 的缓存 */
    fun browserFileChunk(id: String, base64: String, reply: (String) -> Unit)
    /** 交文件（JSON：target、fieldId、files） */
    fun browserFiles(json: String, reply: (String) -> Unit)
    /** 拦下的选文件对话框：system / cancel */
    fun browserChooser(choice: String, reply: (String) -> Unit)
    /** 放掉预备好了没用上的文件（JSON：文件编号的数组） */
    fun browserDiscard(json: String, reply: (String) -> Unit)
    /** 能渲染的文件：enable / source / save / outside / drop */
    fun browserDoc(op: String, id: String, reply: (String) -> Unit)
    /** ⋮ 菜单用到的原生工具 */
    fun browserTool(op: String, json: String, reply: (String) -> Unit)
    /** 在 App 里更新 App：json 是要装的安装包（{ url, sha256, version, code, size }），回最后一步 */
    fun installAppUpdate(json: String, reply: (String) -> Unit)
}

/**
 * 原生桥的方法（对应鸿蒙的 NativeBridge 类）：每次调用的来源、主框架已经由 BridgeChannel 核对过（鸿蒙的 allowed()）。
 * 每换一次地址整个重建（连同 WebView），所以一个实例只认一个来源。
 */
class NativeBridge(private val host: BridgeHost, private val voice: NativeVoice) {
    /** 网页当前还能不能在内部返回上一级（网页经 setCanGoBack 报，原生按返回键时据此决定交给网页还是退出） */
    var canGoBack: Boolean = false
        private set

    fun handle(call: BridgeCall) {
        when (call.method) {
            // 这几个垫片直接读镜像值，只是告诉原生一声（"appVersion" 由 __contact 代替）
            "appVersion", "safeArea", "notifyState" -> Unit
            "notifyTakeOpen" -> host.notifyTaken(call.string(0))
            "notifyResetAsked" -> host.notifyResetAsked()
            "notifyPrepare" -> host.notifyPrepare(call.bool(0)) { call.reply(it) }
            "notifyShow" -> host.notifyShow(call.string(0), call.string(1), call.string(2), call.string(3), call.bool(4)) { call.reply(it) }
            "log" -> Log.i(TAG, "[web] ${call.string(0)}")
            "editServer" -> host.editServer()
            "setColorMode" -> setColorMode(call.string(0))
            "setCanGoBack" -> canGoBack = call.bool(0)
            "setTexts" -> AppTexts.setFromWeb(call.string(0))
            // 原生录音：备好（userAction 为真是按下引起的）、按下、松手、丢掉这一段、放掉录音器
            "voicePrepare" -> voice.prepare(call.bool(0)) { call.reply(it) }
            "voiceStart" -> voice.start { call.reply(it) }
            "voiceStop" -> voice.stop { call.reply(it) }
            "voiceDiscard" -> voice.discard()
            "voiceRelease" -> voice.release()
            "browserAttach" -> host.browserAttach()
            "browserLayout" -> host.browserLayout(call.string(0))
            "browserLoad" -> host.browserLoad(call.string(0))
            "browserNav" -> host.browserNav(call.string(0))
            "browserSide" -> host.browserSide(call.string(0))
            "side.close" -> host.sideAction("close")
            "side.clearSelection" -> host.sideAction("clearSelection")
            "side.ready" -> host.sideAction("ready")
            "browserPage" -> host.browserPage(call.string(0), call.string(1).ifEmpty { "[]" }) { call.reply(it) }
            "browserFileChunk" -> host.browserFileChunk(call.string(0), call.string(1)) { call.reply(it) }
            "browserFiles" -> host.browserFiles(call.string(0)) { call.reply(it) }
            "browserChooser" -> host.browserChooser(call.string(0)) { call.reply(it) }
            "browserDiscard" -> host.browserDiscard(call.string(0).ifEmpty { "[]" }) { call.reply(it) }
            "browserDoc" -> host.browserDoc(call.string(0), call.string(1)) { call.reply(it) }
            "browserTool" -> host.browserTool(call.string(0), call.string(1).ifEmpty { "{}" }) { call.reply(it) }
            "installAppUpdate" -> host.installAppUpdate(call.string(0)) { call.reply(it) }
            else -> Log.w(TAG, "bridge method not handled: ${call.method}")
        }
    }

    /** App 自己放掉录音器（切到后台、页面重新加载、换地址），并告诉网页；不经网页调用 */
    fun releaseVoice(reason: String) = voice.releaseByApp(reason)

    /** 这个桥不用了（换地址、App 退出） */
    fun close() = voice.close()

    /** 外观：system 跟随系统，light / dark 固定 */
    private fun setColorMode(mode: String) {
        if (mode != "system" && mode != "light" && mode != "dark") {
            Log.w(TAG, "unknown color mode: $mode")
            return
        }
        host.colorModeChanged(mode)
    }
}
