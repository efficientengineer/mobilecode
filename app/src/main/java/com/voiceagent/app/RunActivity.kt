package com.voiceagent.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.google.android.material.appbar.MaterialToolbar
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Starts a Python web server from the active workspace (localrun.start) and
 * previews it in a WebView at http://127.0.0.1:<port>/.
 */
class RunActivity : AppCompatActivity() {

    private val scope = MainScope()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_run)

        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        setWorkspaceEnv()

        val toolbar = findViewById<MaterialToolbar>(R.id.runToolbar)
        toolbar.title = "Run"
        toolbar.setNavigationOnClickListener { finish() }

        val urlText = findViewById<TextView>(R.id.runUrl)
        val web = findViewById<WebView>(R.id.webView)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // Development preview: never serve stale content. Always hit the local
        // server and wipe any existing cache so edits show up immediately.
        web.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        web.clearCache(true)
        web.webViewClient = WebViewClient()

        urlText.text = "Starting server…"
        scope.launch {
            val status = withContext(Dispatchers.IO) {
                try {
                    Python.getInstance().getModule("localrun").callAttr("start").toString()
                } catch (e: Throwable) {
                    "Local run failed: ${e.message}"
                }
            }
            urlText.text = status
            val url = status.trim().substringBefore(" ")
            if (url.startsWith("http")) web.loadUrl(url)
        }
    }

    private fun setWorkspaceEnv() {
        val ws = SessionManager(this).activeDir().absolutePath
        val os = Python.getInstance().getModule("os")
        os.get("environ")?.callAttr("__setitem__", "AGENT_WORKSPACE", ws)
    }

    override fun onDestroy() {
        try {
            Python.getInstance().getModule("localrun").callAttr("stop")
        } catch (e: Throwable) {
            // ignore
        }
        super.onDestroy()
    }
}
