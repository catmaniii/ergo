package com.catmaniii.ergo.browser

import org.junit.Assert.assertEquals
import org.junit.Test

/** 内置浏览器"加载完了"之后开着哪一页（票 386）：只认 WebView 历史里当前那一条，下载地址不当成一页 */
class InAppBrowserTest {
    @Test
    fun `正常打开的一页照报的地址`() {
        assertEquals("https://a.example/news", pageAfterLoad("https://a.example/news", "https://a.example/news", "https://a.example/"))
    }

    @Test
    fun `跳转变成下载时回还开着的那一页`() {
        assertEquals("https://a.example/", pageAfterLoad("https://dl.example/app.apk", "https://a.example/", "https://dl.example/app.apk"))
    }

    @Test
    fun `打开的第一个地址就是下载时一页都没有`() {
        assertEquals("", pageAfterLoad("https://dl.example/app.apk", null, "https://dl.example/app.apk"))
        assertEquals("", pageAfterLoad("https://dl.example/app.apk", "about:blank", "https://dl.example/app.apk"))
    }

    @Test
    fun `报的不是网址时不动`() {
        assertEquals("https://a.example/", pageAfterLoad("about:blank", null, "https://a.example/"))
        assertEquals("https://a.example/", pageAfterLoad(null, "https://b.example/", "https://a.example/"))
    }
}
