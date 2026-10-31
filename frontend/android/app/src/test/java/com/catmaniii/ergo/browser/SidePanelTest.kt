package com.catmaniii.ergo.browser

import org.junit.Assert.assertEquals
import org.junit.Test

/** 侧边栏的地址和鸿蒙 browser/SidePanel.ets 的 sideUrlOf 一样：新旧参数名都带，# 后面的不要 */
class SidePanelTest {
    @Test
    fun addsBothParamNames() {
        assertEquals("https://ergo.example/?ergo=side&ergou=side", sideUrlOf("https://ergo.example/"))
    }

    @Test
    fun keepsQueryAndDropsHash() {
        assertEquals("https://ergo.example/?a=1&ergo=side&ergou=side", sideUrlOf("https://ergo.example/?a=1#/tasks"))
    }
}
