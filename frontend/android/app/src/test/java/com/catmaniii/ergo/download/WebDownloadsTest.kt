package com.catmaniii.ergo.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WebDownloadsTest {
    @Test
    fun `说不清类型时不拿它改文件名`() {
        assertNull(nameMime("application/octet-stream"))
        assertNull(nameMime("Application/Octet-Stream; charset=binary"))
        assertNull(nameMime(null))
    }

    @Test
    fun `说得清的类型照用`() {
        assertEquals("application/vnd.android.package-archive", nameMime("application/vnd.android.package-archive"))
        assertEquals("text/html; charset=utf-8", nameMime("text/html; charset=utf-8"))
    }
}
