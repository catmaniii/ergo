package com.catmaniii.ergo.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FullscreenChecksTest {
    @Test
    fun `页面回的宽高读得出来（evaluateJavascript 回的是带引号的 JSON）`() {
        assertEquals(FullscreenContent.Video(640, 360), parseFullscreenContent("\"640x360\""))
        assertEquals(FullscreenContent.Video(360, 640), parseFullscreenContent("\"360x640\""))
    }

    @Test
    fun `还没进全屏、视频还没读出宽高、出错的过一会儿再读`() {
        assertEquals(FullscreenContent.Pending, parseFullscreenContent("\"\""))
        assertEquals(FullscreenContent.Pending, parseFullscreenContent("\"0x0\""))
        assertEquals(FullscreenContent.Pending, parseFullscreenContent("\"640x0\""))
        assertEquals(FullscreenContent.Pending, parseFullscreenContent("null"))
        assertEquals(FullscreenContent.Pending, parseFullscreenContent(null))
        assertEquals(FullscreenContent.Pending, parseFullscreenContent("\"99999999999x1\""))
    }

    @Test
    fun `全屏的不是视频`() {
        assertEquals(FullscreenContent.NotVideo, parseFullscreenContent("\"none\""))
    }

    @Test
    fun `横视频转横屏，竖的、方的、不是视频、读不出来的都不动方向`() {
        assertTrue(wantsLandscape(FullscreenContent.Video(1920, 1080)))
        assertTrue(wantsLandscape(FullscreenContent.Video(641, 640)))
        assertFalse(wantsLandscape(FullscreenContent.Video(1080, 1920)))
        assertFalse(wantsLandscape(FullscreenContent.Video(720, 720)))
        assertFalse(wantsLandscape(FullscreenContent.NotVideo))
        assertFalse(wantsLandscape(FullscreenContent.Pending))
    }

    @Test
    fun `读宽高的脚本：先看全屏的元素本身是不是 video，再找里面第一个，不是视频回 none`() {
        assertTrue(FULLSCREEN_VIDEO_SIZE_JS.contains("document.fullscreenElement"))
        assertTrue(FULLSCREEN_VIDEO_SIZE_JS.contains("e.tagName==='VIDEO'?e:"))
        assertTrue(FULLSCREEN_VIDEO_SIZE_JS.contains("querySelector('video')"))
        assertTrue(FULLSCREEN_VIDEO_SIZE_JS.contains("return 'none'"))
    }
}
