package com.voiceagent.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.google.android.material.appbar.MaterialToolbar
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Starts a Python web server from the active workspace (localrun.start) and
 * previews it in a WebView at http://127.0.0.1:<port>/.
 *
 * Fullscreen: a toolbar ⛶ button (and the back key) toggle IMMERSIVE mode —
 * the toolbar, URL bar, and Android system bars all hide so the game fills the
 * screen. We also implement WebChromeClient.onShowCustomView, so a game's OWN
 * in-page fullscreen button (HTML Fullscreen API) works too — that API is a
 * silent no-op in a WebView without this hook.
 */
class RunActivity : AppCompatActivity() {

    private val scope = MainScope()
    private lateinit var web: WebView
    private lateinit var toolbar: MaterialToolbar
    private lateinit var urlText: TextView
    private var fullscreened = false
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_run)

        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        setWorkspaceEnv()

        toolbar = findViewById(R.id.runToolbar)
        toolbar.title = "Run"
        toolbar.setNavigationOnClickListener { finish() }
        // A text ⛶ action that enters fullscreen. Once fullscreened, the toolbar is
        // hidden, so the back key (onBackPressed) is how you leave.
        toolbar.menu.add(0, MENU_FULLSCREEN, 0, "⛶").apply {
            setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS or MenuItem.SHOW_AS_ACTION_WITH_TEXT)
            setOnMenuItemClickListener { applyImmersive(true); true }
        }

        urlText = findViewById(R.id.runUrl)
        web = findViewById(R.id.webView)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // Development preview: never serve stale content. Always hit the local
        // server and wipe any existing cache so edits show up immediately.
        web.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        web.clearCache(true)
        web.webViewClient = WebViewClient()
        // Support the HTML Fullscreen API from inside the page (a game's own
        // fullscreen button). Without onShowCustomView, requestFullscreen() does
        // nothing in a WebView.
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customCallback = callback
                (window.decorView as FrameLayout).addView(
                    view, FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                applyImmersive(true)
            }

            override fun onHideCustomView() {
                val v = customView ?: return
                (window.decorView as FrameLayout).removeView(v)
                customView = null
                customCallback?.onCustomViewHidden()
                customCallback = null
                applyImmersive(false)
            }
        }

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

    /** Hide/show the toolbar, URL bar, and Android system bars for fullscreened play. */
    private fun applyImmersive(on: Boolean) {
        fullscreened = on
        toolbar.visibility = if (on) View.GONE else View.VISIBLE
        urlText.visibility = if (on) View.GONE else View.VISIBLE
        val c = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            c.hide(WindowInsetsCompat.Type.systemBars())
            c.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            c.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // Leave an in-page (HTML) fullscreen first, then fullscreened, then exit.
        if (customView != null) {
            web.evaluateJavascript(
                "(document.exitFullscreen||document.webkitExitFullscreen).call(document)", null
            )
            return
        }
        if (fullscreened) { applyImmersive(false); return }
        super.onBackPressed()
    }

    private fun setWorkspaceEnv() {
        val ws = SessionManager(this).activeDir().absolutePath
        val os = Python.getInstance().getModule("os")
        os.get("environ")?.callAttr("__setitem__", "AGENT_WORKSPACE", ws)
    }

    override fun onDestroy() {
        // Cancel the scope first so a slow localrun.start can't resume on Main
        // and touch a destroyed Activity's views.
        scope.cancel()
        try {
            Python.getInstance().getModule("localrun").callAttr("stop")
        } catch (e: Throwable) {
            // ignore
        }
        // Tear down the WebView, or it leaks the Activity and keeps the page's
        // JS timers / audio / WebGL running in the background.
        try {
            customCallback?.onCustomViewHidden()
            customView = null
            customCallback = null
            if (this::web.isInitialized) {
                (web.parent as? android.view.ViewGroup)?.removeView(web)
                web.stopLoading()
                web.webChromeClient = null
                web.loadUrl("about:blank")
                web.destroy()
            }
        } catch (_: Throwable) {}
        super.onDestroy()
    }

    companion object {
        private const val MENU_FULLSCREEN = 1
    }
}
