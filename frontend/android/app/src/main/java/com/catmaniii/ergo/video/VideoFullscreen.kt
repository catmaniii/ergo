package com.catmaniii.ergo.video

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.catmaniii.ergo.common.TAG

/**
 * 网页视频真全屏（票 407，对应鸿蒙 video/VideoFullscreen.ets）：网页里的视频进全屏（Fullscreen API、<video> 控件上的全屏按钮）时，
 * WebView 交来一个画着全屏内容的 View（WebChromeClient.onShowCustomView），这里把它放进盖住整个窗口的黑底一层，
 * 藏掉状态栏和导航条（从边缘滑一下临时出来）、屏幕常亮，横视频转横屏（横屏的两个方向都行）。
 * 退出（网页自己退、返回键、切到后台、换地址）时一样样恢复成进去之前的样子：方向回到进去之前的（平常就是跟着系统走）。
 * 主界面和浏览侧边栏两个 WebView 共用这一份，同一时间只有一个全屏。
 */
class VideoFullscreen(private val activity: Activity, private val root: ViewGroup) {
    private class Shown(
        val layer: FrameLayout,
        val callback: WebChromeClient.CustomViewCallback,
        val orientationBefore: Int,
        val keepScreenOnBefore: Boolean,
    )

    private val handler = Handler(Looper.getMainLooper())
    private var shown: Shown? = null
    /** 每进一次全屏加一：上一次没读完的宽高回来时已经不算数 */
    private var session = 0

    val showing: Boolean get() = shown != null

    /** WebChromeClient.onShowCustomView */
    fun show(web: WebView, view: View, callback: WebChromeClient.CustomViewCallback) {
        if (shown != null) {
            // 已经有一个全屏了（另一个 WebView 的）：这个不接，让它退回去
            Log.w(TAG, "video fullscreen: already showing, refuse another")
            callback.onCustomViewHidden()
            return
        }
        val window = activity.window
        val layer = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
        (view.parent as? ViewGroup)?.removeView(view)
        layer.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        // 放在最外层（不在让开状态栏的那层里），盖住主界面、内置浏览器、侧边栏和提示
        root.addView(layer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        val keepScreenOnBefore = window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
        shown = Shown(layer, callback, activity.requestedOrientation, keepScreenOnBefore)
        session += 1
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowInsetsControllerCompat(window, root).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        Log.i(TAG, "video fullscreen entered")
        probe(web, session, FULLSCREEN_PROBE_TRIES)
    }

    /** WebChromeClient.onHideCustomView：网页退出了全屏（控件上的按钮、页面自己退、App 让它退之后） */
    fun hide() {
        val current = shown ?: return
        shown = null
        session += 1
        current.layer.removeAllViews()
        root.removeView(current.layer)
        val window = activity.window
        WindowInsetsControllerCompat(window, root).apply {
            show(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
        }
        if (!current.keepScreenOnBefore) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        activity.requestedOrientation = current.orientationBefore
        Log.i(TAG, "video fullscreen exited")
    }

    /**
     * App 让网页退出全屏（返回键、切到后台、换地址）：先恢复窗口，再告诉 WebView（它随后的 onHideCustomView 到这里已经没事做）。
     * 不在全屏回 false
     */
    fun exit(): Boolean {
        val current = shown ?: return false
        hide()
        try {
            current.callback.onCustomViewHidden()
        } catch (e: Exception) {
            Log.w(TAG, "video fullscreen: exit callback failed", e)
        }
        return true
    }

    /**
     * 读全屏的是不是视频、多宽多高：横的转横屏。页面还没换上全屏的元素、视频还没读出宽高时隔一会儿再读，
     * 读几次还没有就不转（不是视频的也不转）
     */
    private fun probe(web: WebView, at: Int, triesLeft: Int) {
        if (at != session || shown == null) return
        web.evaluateJavascript(FULLSCREEN_VIDEO_SIZE_JS) { result ->
            if (at != session || shown == null) return@evaluateJavascript
            when (val content = parseFullscreenContent(result)) {
                FullscreenContent.Pending ->
                    if (triesLeft > 1) {
                        handler.postDelayed({ probe(web, at, triesLeft - 1) }, FULLSCREEN_PROBE_INTERVAL_MS)
                    } else {
                        Log.i(TAG, "video fullscreen: size unknown, orientation unchanged")
                    }
                else -> {
                    val landscape = wantsLandscape(content)
                    Log.i(TAG, "video fullscreen: $content, landscape $landscape")
                    if (landscape) activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                }
            }
        }
    }
}
