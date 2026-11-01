package com.catmaniii.ergo.browser

import org.json.JSONObject

/**
 * 浏览侧边栏（对应鸿蒙 browser/SidePanel.ets，147 号票）在 App 这一侧：原生的内置浏览器盖在二狗的网页上面，二狗的网页画的东西到不了它上面，
 * 所以侧边栏由 App 另开一个 WebView 承载：加载二狗的网页的侧边栏模式（地址加 ?ergo=side，网页一侧 packages/web/src/app/side-mode.ts），摆在最上面——
 * - 摆在哪由二狗的网页（"浏览"页）经原生桥 browserSide(json) 报来：宽屏右边一块，窄屏整屏盖住；第一次展开时才建，之后留着（收起只是藏起来），
 *   从右边滑进滑出；
 * - 报来的 view（JSON 字符串）原样转给侧边栏的网页（window.__ergoSide），侧边栏的网页起来时调 ready() 再要一次；
 * - 侧边栏的网页能调的只有 window.ergoSide 的三个方法和一小份原生桥（版本号、日志、录音那一组），都只认配好的来源。
 */

/** browserSide(json)：侧边栏摆在哪（物理像素）、交给侧边栏网页的样子（JSON 字符串） */
class SideLayout(val frame: BrowserFrame, val view: String)

/** 报来的侧边栏（JSON）；不对是 null */
fun parseSideLayout(json: String): SideLayout? {
    val value = try {
        JSONObject(json)
    } catch (_: Exception) {
        return null
    }
    val dpr = (value.opt("dpr") as? Number)?.toDouble()?.takeIf { it.isFinite() && it > 0 } ?: return null
    val view = value.opt("view") as? String ?: return null
    val side = value.optJSONObject("side") ?: return null
    if (side.opt("visible") !is Boolean) return null
    val frame = frameOf(side, dpr) ?: return null
    return SideLayout(frame, view)
}

/** 侧边栏的网页的地址：二狗的地址（去掉 # 后面的）加 ergo=side */
fun sideUrlOf(href: String): String {
    val base = href.substringBefore('#')
    return "$base${if (base.contains('?')) "&" else "?"}ergo=side"
}
