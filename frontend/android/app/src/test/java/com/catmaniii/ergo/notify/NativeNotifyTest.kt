package com.catmaniii.ergo.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 通知的规矩和鸿蒙 notify/NativeNotify.ets 一样：编号同一个算法（同一件事只出一条），页面地址只认 #/ 开头 */
class NativeNotifyTest {
    @Test
    fun numberMatchesHarmonyIncludingOverflow() {
        assertEquals(107154, noticeNumber("n-1"))
        // 期望值是照鸿蒙的 numberOf 算出来的（中文、溢出都算到）
        assertEquals(1806641702, noticeNumber("reminder:提醒-2026-11-01"))
    }

    @Test
    fun routeMustBeInsideTheWebPage() {
        assertTrue(isNoticeRoute("#/tasks"))
        assertFalse(isNoticeRoute("https://evil.example/"))
        assertFalse(isNoticeRoute("javascript:alert(1)"))
        assertFalse(isNoticeRoute("#tasks"))
        assertFalse(isNoticeRoute("#/" + "a".repeat(600)))
    }

    @Test
    fun idMustNotBeEmptyOrHuge() {
        assertTrue(isNoticeId("n-1"))
        assertFalse(isNoticeId(""))
        assertFalse(isNoticeId("a".repeat(201)))
    }
}
