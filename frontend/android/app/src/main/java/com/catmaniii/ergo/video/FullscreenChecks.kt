package com.catmaniii.ergo.video

/**
 * 网页视频真全屏（票 407）的判断，不碰系统：JVM 单测（app/src/test/.../video/FullscreenChecksTest.kt）直接测。
 *
 * WebView 进全屏时（onShowCustomView）不给视频宽高，App 在页面里跑 [FULLSCREEN_VIDEO_SIZE_JS] 读：
 * 全屏的元素就是 video 读它，里面套着 video 的读第一个（和鸿蒙 ArkWeb 的 FullScreenEnterEvent.videoWidth/videoHeight 一个口径）。
 */
const val FULLSCREEN_VIDEO_SIZE_JS =
    "(function(){var e=document.fullscreenElement||document.webkitFullscreenElement;if(!e)return '';" +
        "var v=e.tagName==='VIDEO'?e:(e.querySelector?e.querySelector('video'):null);if(!v)return 'none';" +
        "return v.videoWidth+'x'+v.videoHeight;})()"

/** 读一次之后再读的间隔、最多读几次：页面还没把全屏的元素换上、视频还没读出宽高时等一等，约 3 秒还没有就不转了 */
const val FULLSCREEN_PROBE_INTERVAL_MS = 250L
const val FULLSCREEN_PROBE_TRIES = 12

/** 页面里读到的全屏的东西 */
sealed interface FullscreenContent {
    /** 还读不出来：页面还没把全屏的元素换上，或者视频还没读出宽高（宽高是 0）。过一会儿再读 */
    data object Pending : FullscreenContent

    /** 全屏的不是视频（里面也没有 video）：不转方向 */
    data object NotVideo : FullscreenContent

    data class Video(val width: Int, val height: Int) : FullscreenContent
}

private val SIZE = Regex("^(\\d+)x(\\d+)$")

/** evaluateJavascript 回的是 JSON（字符串带引号，出错是 null） */
fun parseFullscreenContent(evaluated: String?): FullscreenContent {
    val text = evaluated?.trim()?.removeSurrounding("\"") ?: return FullscreenContent.Pending
    if (text == "none") return FullscreenContent.NotVideo
    val match = SIZE.matchEntire(text) ?: return FullscreenContent.Pending
    val width = match.groupValues[1].toIntOrNull() ?: return FullscreenContent.Pending
    val height = match.groupValues[2].toIntOrNull() ?: return FullscreenContent.Pending
    if (width <= 0 || height <= 0) return FullscreenContent.Pending
    return FullscreenContent.Video(width, height)
}

/**
 * 转不转横屏：横视频（宽 > 高）转，横屏的两个方向都行；竖的、方的保持原来的方向（跟系统走，不锁竖屏：
 * 平板、阔折叠本来就是横着拿的）；不是视频、读不出宽高的也不动
 */
fun wantsLandscape(content: FullscreenContent): Boolean = content is FullscreenContent.Video && content.width > content.height
