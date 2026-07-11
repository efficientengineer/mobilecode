package com.voiceagent.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.net.Uri
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Thin native shell: a full-screen WebView whose UI is HTML/CSS/JS loaded from
 * app storage (bundled default in assets/web, or an OTA override in
 * filesDir/web). All UI logic lives in the web layer; this class exposes a
 * generic `Native.invoke` bridge to the Python agent, git_ops, local runner,
 * speech, and TTS.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var sessions: SessionManager
    private var speech: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val notifyPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // File chooser plumbing so the web layer's <input type=file> works.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            fileChooserCallback?.onReceiveValue(uris)
            fileChooserCallback = null
        }

    // Text/URL shared into the app before the web UI was ready to receive it.
    private var pendingShared: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessions = SessionManager(this)

        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        prepareEnv()

        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) tts?.language = Locale.getDefault()
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) micPermission.launch(Manifest.permission.RECORD_AUDIO)

        createNotifyChannel()
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.webViewClient = WebViewClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?, callback: ValueCallback<Array<Uri>>?,
                params: WebChromeClient.FileChooserParams?
            ): Boolean {
                val intent = params?.createIntent() ?: return false
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    fileChooserLauncher.launch(intent); true
                } catch (e: Throwable) {
                    fileChooserCallback = null; false
                }
            }
        }
        web.addJavascriptInterface(Bridge(), "Native")
        setContentView(web)
        loadUi()

        // Text/URL shared into the app (from another app's Share sheet).
        pendingShared = extractShared(intent)
    }

    private fun extractShared(intent: Intent?): String? {
        if (intent == null || intent.action != Intent.ACTION_SEND) return null
        if (intent.type != "text/plain") return null
        return intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.ifBlank { null }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val t = extractShared(intent) ?: return
        // Web is live now — deliver straight to the composer.
        event("shared-text", t)
    }

    private var isForeground = true
    override fun onResume() { super.onResume(); isForeground = true }
    override fun onPause() { super.onPause(); isForeground = false }

    private fun createNotifyChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(
                NOTIFY_CHANNEL, "Agent replies", NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Fires when the agent replies or needs your input"
                enableVibration(true)
            }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }

    /** Vibrate always; post a heads-up notification only when backgrounded. */
    private fun notifyUser(title: String, body: String) {
        try {
            val vib = if (Build.VERSION.SDK_INT >= 31) {
                (getSystemService(VIBRATOR_MANAGER_SERVICE)
                    as android.os.VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            if (Build.VERSION.SDK_INT >= 26) {
                vib.vibrate(VibrationEffect.createOneShot(220, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION") vib.vibrate(220)
            }
        } catch (_: Throwable) {}

        if (isForeground) return
        try {
            val intent = Intent(this, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pi = android.app.PendingIntent.getActivity(
                this, 0, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or
                    android.app.PendingIntent.FLAG_IMMUTABLE
            )
            val n = NotificationCompat.Builder(this, NOTIFY_CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_SOUND)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build()
            if (Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED
            ) {
                (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                    .notify(NOTIFY_ID, n)
            }
        } catch (_: Throwable) {}
    }

    private fun loadUi() {
        val override = File(filesDir, "web/index.html")
        web.loadUrl(
            if (override.exists()) "file://${override.absolutePath}"
            else "file:///android_asset/web/index.html"
        )
    }

    // --- Environment ------------------------------------------------------

    private fun globalLead(): String {
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        return prefs.getString("LEAD_MODEL", null)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.lead_model_default)
    }

    private fun globalWorker(): String =
        getSharedPreferences("keys", MODE_PRIVATE).getString("WORKER_MODEL", null)
            ?.takeIf { it.isNotBlank() } ?: getString(R.string.worker_model_default)

    private fun effectiveModels(): Pair<String, String> {
        val m = sessions.readMeta(sessions.activeId())
        return if (m.modelsConfigured) {
            (m.orchestratorModel.ifBlank { globalLead() }) to m.implementerModel
        } else {
            globalLead() to globalWorker()
        }
    }

    private fun prepareEnv() {
        val os = Python.getInstance().getModule("os")
        fun set(k: String, v: String) = os.get("environ")?.callAttr("__setitem__", k, v)
        set("AGENT_WORKSPACE", sessions.activeDir().absolutePath)
        set("HOME", filesDir.absolutePath)
        val pyOverride = File(filesDir, "py_override").apply { mkdirs() }
        set("AGENT_OVERRIDE", File(pyOverride, "orchestrator.py").absolutePath)
        set("AGENT_OVERRIDE_DIR", pyOverride.absolutePath)
        // Everything the OTA loader (ota.py) needs to update ANY runtime file:
        // repo/branch to fetch from and the device roots files land in.
        set("OTA_REPO", REPO)
        set("OTA_BRANCH", branch())
        set("OTA_WEB_DIR", File(filesDir, "web").absolutePath)
        set("OTA_FILES_DIR", filesDir.absolutePath)
        // Put the override dir FIRST on sys.path so a downloaded copy of ANY
        // module — including agent_loader.py and ota.py themselves — wins over
        // the bundled one. This is what makes the whole brain hot-updatable.
        val sysPath = Python.getInstance().getModule("sys").get("path")
        if (sysPath?.callAttr("count", pyOverride.absolutePath)?.toInt() == 0) {
            sysPath.callAttr("insert", 0, pyOverride.absolutePath)
        }
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        prefs.getString("ANTHROPIC_API_KEY", null)?.let { set("ANTHROPIC_API_KEY", it) }
        prefs.getString("DEEPSEEK_API_KEY", null)?.let { set("DEEPSEEK_API_KEY", it) }
        prefs.getString("OPENAI_API_KEY", null)?.let { set("OPENAI_API_KEY", it) }
        prefs.getString("GITHUB_TOKEN", null)?.let { set("GITHUB_TOKEN", it) }
        val (lead, worker) = effectiveModels()
        set("LEAD_MODEL", lead)
        set("WORKER_MODEL", worker)
        set("AGENT_FALLBACK_MODEL", prefs.getString("AGENT_FALLBACK_MODEL", "").orEmpty())
    }

    // --- Bridge -----------------------------------------------------------

    inner class Bridge {
        @JavascriptInterface
        fun invoke(reqId: String, action: String, argJson: String) {
            lifecycleScope.launch {
                try {
                    val arg = JSONObject(if (argJson.isBlank()) "{}" else argJson)
                    val result = handle(action, arg)
                    resolve(reqId, result.toString())
                } catch (e: Throwable) {
                    reject(reqId, e.message ?: "error")
                }
            }
        }
    }

    private fun resolve(reqId: String, json: String) = runOnUiThread {
        web.evaluateJavascript(
            "window.nativeResolve(${JSONObject.quote(reqId)}, ${JSONObject.quote(json)})", null
        )
    }

    private fun reject(reqId: String, msg: String) = runOnUiThread {
        web.evaluateJavascript(
            "window.nativeReject(${JSONObject.quote(reqId)}, ${JSONObject.quote(msg)})", null
        )
    }

    private fun event(type: String, payload: String) = runOnUiThread {
        web.evaluateJavascript(
            "window.nativeEvent(${JSONObject.quote(type)}, ${JSONObject.quote(payload)})", null
        )
    }

    private fun py(module: String) = Python.getInstance().getModule(module)
    private fun text(s: String) = JSONObject().put("text", s)

    /** Dispatch a bridge action, returning a JSON object for the web layer. */
    private suspend fun handle(action: String, arg: JSONObject): JSONObject = when (action) {
        "session.meta" -> {
            val m = sessions.readMeta(sessions.activeId())
            val (lead, worker) = effectiveModels()
            // Emit "activeRepo" (unchanged key) so the web layer keeps working.
            JSONObject().put("name", m.name).put("activeRepo", m.repo)
                .put("orchestrator", lead).put("implementer", worker)
        }
        "session.list" -> {
            val arr = JSONArray()
            sessions.list().forEach {
                arr.put(JSONObject().put("id", it.id).put("name", it.name).put("activeRepo", it.repo))
            }
            JSONObject().put("activeId", sessions.activeId()).put("sessions", arr)
        }
        "session.listRepos" -> {
            JSONObject().put("repos", JSONArray(sessions.listRepos()))
        }
        "session.listSessions" -> {
            val arr = JSONArray()
            sessions.listSessions(arg.optString("repo")).forEach {
                arr.put(JSONObject().put("id", it.id).put("name", it.name).put("activeRepo", it.repo))
            }
            JSONObject().put("activeId", sessions.activeId()).put("sessions", arr)
        }
        "session.create" -> withContext(Dispatchers.IO) {
            // Optional repo: when provided the session is bound to it immediately;
            // otherwise it's created unassigned and bound later by git.clone /
            // git.createRepo (write-once via SessionManager.assignRepo).
            val repo = arg.optString("repo").trim()
            val id = if (repo.isNotBlank()) sessions.create(repo, arg.optString("name"))
                     else sessions.create(arg.optString("name"))
            sessions.setActive(id); prepareEnv()
            JSONObject().put("id", id)
        }
        "session.attachRepo" -> withContext(Dispatchers.IO) {
            val ok = sessions.assignRepo(sessions.activeId(), arg.getString("repo").trim())
            prepareEnv()
            JSONObject().put("ok", ok)
        }
        "session.setActive" -> withContext(Dispatchers.IO) {
            sessions.setActive(arg.getString("id")); prepareEnv()
            JSONObject().put("ok", true)
        }
        "session.rename" -> withContext(Dispatchers.IO) {
            sessions.rename(arg.getString("id"), arg.optString("name"))
            JSONObject().put("ok", true)
        }
        "session.delete" -> withContext(Dispatchers.IO) {
            val id = arg.getString("id")
            sessions.delete(id)
            // Rebind to whatever session is now active (activeId() creates a
            // fresh default if we just deleted the last/active one).
            sessions.activeId(); prepareEnv()
            JSONObject().put("ok", true).put("activeId", sessions.activeId())
        }
        "session.setModels" -> withContext(Dispatchers.IO) {
            sessions.setModels(sessions.activeId(),
                arg.optString("orchestrator").trim(), arg.optString("implementer").trim())
            prepareEnv()
            JSONObject().put("ok", true)
        }
        "agent.run" -> withContext(Dispatchers.IO) {
            // The orchestrator now owns the discussion/context (in the project
            // folder), so we just set the mode and run. A foreground service
            // keeps the run alive if the user switches apps or the screen dims.
            py("os").get("environ")?.callAttr("__setitem__", "AGENT_MODE", arg.optString("mode", "auto"))
            withAgentService {
                text(py("agent_loader").callAttr("run_task", arg.getString("task")).toString())
            }
        }
        "plan.approve" -> withContext(Dispatchers.IO) {
            withAgentService {
                text(py("agent_loader").callAttr("execute_plan").toString())
            }
        }
        "orch" -> withContext(Dispatchers.IO) {
            // Generic call into an orchestrator function (OTA-updatable), so
            // new context/project features ship without a native change.
            val fn = arg.getString("fn")
            val body = {
                text(py("agent_loader").callAttr("op", fn, arg.optString("arg", "")).toString())
            }
            if (fn == "fix_build") withAgentService(body) else body()
        }
        "py.call" -> withContext(Dispatchers.IO) {
            // Generic escape hatch. Routed through agent_loader.call_any so the
            // OTA-OVERRIDE copy of the target module is used, not the stale
            // bundled one — otherwise an OTA update wouldn't take effect here.
            val a = arg.optJSONArray("args")
            val args: Array<Any?> = if (a == null) arrayOf() else Array(a.length()) { a.get(it) }
            text(py("agent_loader").callAttr(
                "call_any", arg.getString("module"), arg.getString("fn"), *args).toString())
        }
        "shared.consume" -> {
            val t = pendingShared ?: ""
            pendingShared = null
            JSONObject().put("text", t)
        }
        "agent.commit" -> withContext(Dispatchers.IO) { text(py("orchestrator").callAttr("commit_now").toString()) }
        "git.currentBranch" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("current_branch").toString()) }
        "git.push" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("push").toString()) }
        "git.pull" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("pull").toString()) }
        "git.balances" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("balances").toString()) }
        "git.cloudBuild" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("cloud_build").toString()) }
        "git.buildStatus" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("latest_build").toString()) }
        "git.createRepo" -> withContext(Dispatchers.IO) {
            val r = py("git_ops").callAttr("create_repo", arg.getString("name"), true).toString()
            val prefix = listOf("Created ", "Using existing ").firstOrNull { r.startsWith(it) }
            if (prefix != null) {
                // Write-once: bind this repo to the (unassigned) active session,
                // moving its folder under the repo. No-op if already bound.
                sessions.assignRepo(sessions.activeId(), r.removePrefix(prefix).trim())
                prepareEnv()
            }
            text(r)
        }
        "git.listRepos" -> withContext(Dispatchers.IO) {
            JSONObject().put("repos", JSONArray(py("git_ops").callAttr("list_repos").toString()))
        }
        "git.clone" -> withContext(Dispatchers.IO) {
            val full = arg.getString("full")
            val r = py("git_ops").callAttr("clone_repo", full).toString()
            // Bind the repo to the active session (write-once), then re-point the
            // env at the (possibly moved) session folder.
            sessions.assignRepo(sessions.activeId(), full)
            prepareEnv()
            text(r)
        }
        "git.setActiveRepo" -> withContext(Dispatchers.IO) {
            // Back-compat alias (older web builds). A session's repo is write-once,
            // so this binds it if unassigned and is otherwise a no-op — it never
            // re-points an already-bound session at a different repo.
            val full = arg.getString("full")
            val r = py("git_ops").callAttr("set_active_repo", full).toString()
            sessions.assignRepo(sessions.activeId(), full)
            prepareEnv()
            text(r)
        }
        "models.aggregate" -> withContext(Dispatchers.IO) {
            JSONObject().put("models", JSONArray(aggregateModels()))
        }
        "settings.get" -> {
            val p = getSharedPreferences("keys", MODE_PRIVATE)
            JSONObject()
                .put("anthropicKey", p.getString("ANTHROPIC_API_KEY", ""))
                .put("deepseekKey", p.getString("DEEPSEEK_API_KEY", ""))
                .put("openaiKey", p.getString("OPENAI_API_KEY", ""))
                .put("githubToken", p.getString("GITHUB_TOKEN", ""))
                .put("leadModel", p.getString("LEAD_MODEL", "")?.ifBlank { getString(R.string.lead_model_default) })
                .put("workerModel", p.getString("WORKER_MODEL", "")?.ifBlank { getString(R.string.worker_model_default) })
                .put("fallbackModel", p.getString("AGENT_FALLBACK_MODEL", ""))
                .put("branch", p.getString("AGENT_BRANCH", "")?.ifBlank { getString(R.string.agent_branch_default) })
                .put("speechSilenceMs", p.getString("SPEECH_SILENCE_MS", "")?.ifBlank { SPEECH_SILENCE_MS.toString() })
                .put("speechContinuous", p.getString("SPEECH_CONTINUOUS", "1"))
        }
        "settings.save" -> withContext(Dispatchers.IO) {
            getSharedPreferences("keys", MODE_PRIVATE).edit()
                .putString("ANTHROPIC_API_KEY", arg.optString("anthropicKey"))
                .putString("DEEPSEEK_API_KEY", arg.optString("deepseekKey"))
                .putString("OPENAI_API_KEY", arg.optString("openaiKey"))
                .putString("GITHUB_TOKEN", arg.optString("githubToken"))
                .putString("LEAD_MODEL", arg.optString("leadModel"))
                .putString("WORKER_MODEL", arg.optString("workerModel"))
                .putString("AGENT_FALLBACK_MODEL", arg.optString("fallbackModel"))
                .putString("AGENT_BRANCH", arg.optString("branch"))
                .putString("SPEECH_SILENCE_MS", arg.optString("speechSilenceMs"))
                .putString("SPEECH_CONTINUOUS", if (arg.optBoolean("speechContinuous", true)) "1" else "0")
                .apply()
            prepareEnv()
            JSONObject().put("ok", true)
        }
        "speak" -> {
            tts?.speak(arg.optString("text"), TextToSpeech.QUEUE_FLUSH, null, "a")
            JSONObject().put("ok", true)
        }
        "notify" -> {
            withContext(Dispatchers.Main) {
                notifyUser(arg.optString("title", "Voice Agent"), arg.optString("body", "Ready"))
            }
            JSONObject().put("ok", true)
        }
        "listen" -> {
            val on = arg.optBoolean("on", true)
            withContext(Dispatchers.Main) { if (on) startListening() else stopDictation() }
            JSONObject().put("ok", true)
        }
        "run.active" -> JSONObject().put("active", activeRuns > 0)
        "pr.watch" -> {
            val watch = getSharedPreferences(PrWatchWorker.PREFS, MODE_PRIVATE)
            val (lead, worker) = effectiveModels()
            val autofix = arg.optBoolean("autofix", false)
            watch.edit()
                .putString("workspace", sessions.activeDir().absolutePath)
                .putString("lead", lead)
                .putString("worker", worker)
                .putBoolean("autofix", autofix)
                .remove("lastNotified")
                .apply()
            val req = PeriodicWorkRequestBuilder<PrWatchWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
                PrWatchWorker.WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
            text("Watching this PR" + (if (autofix) " with auto-fix" else "") +
                " — you'll be notified on CI changes.")
        }
        "pr.unwatch" -> {
            WorkManager.getInstance(applicationContext).cancelUniqueWork(PrWatchWorker.WORK_NAME)
            getSharedPreferences(PrWatchWorker.PREFS, MODE_PRIVATE).edit().clear().apply()
            text("Stopped watching.")
        }
        "pr.watchState" -> {
            val watch = getSharedPreferences(PrWatchWorker.PREFS, MODE_PRIVATE)
            JSONObject().put("watching", watch.contains("workspace"))
                .put("autofix", watch.getBoolean("autofix", false))
        }
        "battery.exempt" -> {
            // Ask Android to exclude the app from battery optimization so
            // long background runs aren't killed by Doze.
            val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
            val already = pm.isIgnoringBatteryOptimizations(packageName)
            if (!already) {
                try {
                    startActivity(Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:$packageName")))
                } catch (_: Throwable) {}
            }
            JSONObject().put("exempt", already)
        }
        "run" -> { withContext(Dispatchers.Main) { startActivity(Intent(this@MainActivity, RunActivity::class.java)) }; JSONObject().put("ok", true) }
        "updateAgent" -> withContext(Dispatchers.IO) { text(otaUpdate("agent")) }
        "updateUI" -> withContext(Dispatchers.IO) {
            val r = otaUpdate("ui"); runOnUiThread { loadUi() }; text(r)
        }
        "updateAll" -> withContext(Dispatchers.IO) {
            val r = otaUpdate("all"); runOnUiThread { loadUi() }; text(r)
        }
        "web.runtimeCheck" -> webRuntimeCheck()
        else -> JSONObject().put("text", "unknown action: $action")
    }

    // --- OTA updates ------------------------------------------------------

    // --- Foreground service around long agent runs ------------------------
    // The counter lives in the companion so it survives Activity recreation:
    // a freshly-created UI can ask "is a run still going?" (run.active) and
    // reattach its live view instead of looking dead. Service intents use the
    // application context for the same reason — the launching Activity may be
    // gone by the time the run finishes.

    private fun <T> withAgentService(body: () -> T): T {
        val app = applicationContext
        synchronized(MainActivity) {
            if (activeRuns++ == 0) {
                try {
                    ContextCompat.startForegroundService(
                        app, Intent(app, AgentService::class.java))
                } catch (_: Throwable) {}
            }
        }
        try {
            return body()
        } finally {
            synchronized(MainActivity) {
                if (--activeRuns == 0) {
                    try { app.stopService(Intent(app, AgentService::class.java)) }
                    catch (_: Throwable) {}
                }
            }
        }
    }

    private fun branch(): String =
        getSharedPreferences("keys", MODE_PRIVATE).getString("AGENT_BRANCH", "")
            ?.takeIf { it.isNotBlank() } ?: getString(R.string.agent_branch_default)

    private fun fetchRaw(path: String): String {
        val url = URL("https://raw.githubusercontent.com/$REPO/${branch()}/$path")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000; readTimeout = 20000
        }
        try {
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode} for $path")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    // The OTA file list is fetched from ota_manifest.json in the repo, so adding
    // a NEW module or web file later needs only a manifest edit — never a new
    // APK. Falls back to the built-in lists if the manifest can't be read.
    private fun manifestList(key: String, fallback: List<String>): List<String> =
        try {
            val arr = JSONObject(fetchRaw("ota_manifest.json")).optJSONArray(key)
            if (arr == null) fallback
            else (0 until arr.length()).map { arr.getString(it) }.ifEmpty { fallback }
        } catch (e: Throwable) { fallback }

    // All update logic lives in ota.py (itself OTA-updatable, manifest-driven,
    // self-updating): Kotlin only exports the env and delegates. The legacy
    // built-in updaters below remain ONLY as a bootstrap/repair fallback — if
    // ota.py is missing or broken they restore enough (including a fresh
    // ota.py, which is in the manifest's python list) to get back on the
    // manifest-driven path.
    private fun otaUpdate(kind: String): String = try {
        prepareEnv() // pick up a branch/setting change made this session
        py("ota").callAttr("update", kind).toString()
    } catch (e: Throwable) {
        val legacy = when (kind) {
            "ui" -> legacyUpdateUI()
            "agent" -> legacyUpdateAgent()
            else -> legacyUpdateAgent() + " · " + legacyUpdateUI()
        }
        "$legacy (via built-in fallback: ${e.message?.take(120)})"
    }

    private fun legacyUpdateAgent(): String = try {
        val dir = File(filesDir, "py_override").apply { mkdirs() }
        val files = manifestList("python", listOf("llm.py", "agent_tools.py",
            "agentloop.py", "git_ops.py", "localrun.py", "templates.py", "orchestrator.py"))
        val fetched = files.map { it to fetchRaw("app/src/main/python/$it") }
        fetched.forEach { (name, body) ->
            File(dir, name).apply { parentFile?.mkdirs() }.writeText(body)
        }
        "Agent updated (${files.size} modules) — next task uses the new code"
    } catch (e: Throwable) {
        "Update agent failed: ${e.message}"
    }

    private fun legacyUpdateUI(): String = try {
        val dir = File(filesDir, "web").apply { mkdirs() }
        val files = manifestList("web", listOf("index.html", "style.css", "app.js"))
        for (f in files) {
            File(dir, f).apply { parentFile?.mkdirs() }
                .writeText(fetchRaw("app/src/main/assets/web/$f"))
        }
        runOnUiThread { loadUi() }
        "UI updated"
    } catch (e: Throwable) {
        "Update UI failed: ${e.message}"
    }

    // --- Headless web runtime check --------------------------------------
    // Loads the running preview in a hidden 1x1 WebView and collects JS console
    // errors (uncaught exceptions surface here too) over a short settle window,
    // so the reviewer catches runtime breakage that static checks can't. Returns
    // {url, errors:[...]} — or {skipped:true} fast when there's no web entry.
    private suspend fun webRuntimeCheck(): JSONObject {
        val ws = sessions.activeDir()
        val hasWeb = withContext(Dispatchers.IO) {
            File(ws, "index.html").exists() || ws.walkTopDown().any {
                it.isFile && it.extension.lowercase() in setOf("html", "js", "mjs")
            }
        }
        if (!hasWeb) return JSONObject().put("skipped", true).put("errors", JSONArray())
        val url = withContext(Dispatchers.IO) {
            py("localrun").callAttr("start")
            py("localrun").callAttr("url").toString()
        }
        return withContext(Dispatchers.Main) {
            val errors = ArrayList<String>()
            val done = CompletableDeferred<Unit>()
            val root = window.decorView as ViewGroup
            val probe = WebView(this@MainActivity)
            probe.settings.javaScriptEnabled = true
            probe.settings.domStorageEnabled = true
            probe.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                    if (cm.messageLevel() == ConsoleMessage.MessageLevel.ERROR && errors.size < 25) {
                        val src = cm.sourceId()?.substringAfterLast('/') ?: ""
                        errors.add(cm.message() +
                            (if (src.isNotBlank()) " ($src:${cm.lineNumber()})" else ""))
                    }
                    return true
                }
            }
            probe.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, u: String?) {
                    // Settle briefly for async/module/rAF errors, then finish.
                    probe.postDelayed({ if (!done.isCompleted) done.complete(Unit) }, 2500L)
                }
            }
            root.addView(probe, ViewGroup.LayoutParams(1, 1))
            probe.loadUrl(url)
            // Hard ceiling in case the page never finishes loading.
            probe.postDelayed({ if (!done.isCompleted) done.complete(Unit) }, 7000L)
            done.await()
            try { root.removeView(probe); probe.destroy() } catch (_: Throwable) {}
            // Free the port when the check is done — don't leave 8765 bound
            // between steps (localrun.start still recovers if it's held, but a
            // tidy stop keeps the next Run on the preferred port).
            withContext(Dispatchers.IO) { try { py("localrun").callAttr("stop") } catch (_: Throwable) {} }
            JSONObject().put("url", url).put("errors", JSONArray(errors.toList()))
        }
    }

    // --- Aggregate model list --------------------------------------------

    private fun aggregateModels(): List<String> {
        val p = getSharedPreferences("keys", MODE_PRIVATE)
        val out = mutableListOf<String>()
        p.getString("ANTHROPIC_API_KEY", "")?.takeIf { it.isNotBlank() }?.let {
            runCatching { out += fetchModels("https://api.anthropic.com/v1/models?limit=100", "anthropic/") { c ->
                c.setRequestProperty("x-api-key", it); c.setRequestProperty("anthropic-version", "2023-06-01") } }
        }
        p.getString("DEEPSEEK_API_KEY", "")?.takeIf { it.isNotBlank() }?.let {
            runCatching { out += fetchModels("https://api.deepseek.com/v1/models", "deepseek/") { c ->
                c.setRequestProperty("Authorization", "Bearer $it") } }
        }
        p.getString("OPENAI_API_KEY", "")?.takeIf { it.isNotBlank() }?.let {
            runCatching {
                // /v1/models lists everything (audio, image, embeddings, tts…);
                // keep only chat/reasoning text models the agent loop can drive.
                out += fetchModels("https://api.openai.com/v1/models", "openai/") { c ->
                    c.setRequestProperty("Authorization", "Bearer $it") }
                    .filter { m ->
                        val n = m.removePrefix("openai/").lowercase()
                        (n.startsWith("gpt-") || n.startsWith("chatgpt") ||
                            n.matches(Regex("^o[0-9].*"))) &&
                            listOf("audio", "realtime", "transcribe", "tts", "image",
                                "search", "embed", "moderation", "instruct").none { n.contains(it) }
                    }
                    .sorted()
            }
        }
        return out
    }

    private fun fetchModels(url: String, prefix: String, auth: (HttpURLConnection) -> Unit): List<String> {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000; readTimeout = 15000; auth(this)
        }
        try {
            if (conn.responseCode != 200) return emptyList()
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val data = JSONObject(body).optJSONArray("data") ?: return emptyList()
            return (0 until data.length()).mapNotNull {
                data.optJSONObject(it)?.optString("id")?.takeIf { s -> s.isNotBlank() }
            }.map { "$prefix$it" }
        } finally {
            conn.disconnect()
        }
    }

    // --- Speech -----------------------------------------------------------
    // Naive single-shot dictation: one recognizer session per Speak press,
    // ended by the trailing-silence window (default 7s). The old auto-restart
    // loop kept re-triggering the mic and raced the toggle (you often had to
    // press twice), so it's gone — the session ends when you stop talking.

    private var dictating = false
    private var speechIntent: Intent? = null

    private fun silenceMs(): Int =
        getSharedPreferences("keys", MODE_PRIVATE)
            .getString("SPEECH_SILENCE_MS", "")?.toIntOrNull()?.coerceIn(500, 60000) ?: SPEECH_SILENCE_MS

    private fun buildSpeechIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            // Trailing silence before ending (honored on some devices; auto-
            // restart covers the rest). Tunable in Settings, no APK needed.
            val ms = silenceMs()
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, ms)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, ms)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1500)
        }

    private fun startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            event("status", "Speech unavailable")
            return
        }
        dictating = true
        if (speech == null) {
            speech = SpeechRecognizer.createSpeechRecognizer(this).apply {
                setRecognitionListener(object : RecognitionListener {
                    override fun onResults(results: Bundle?) {
                        val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull()?.trim().orEmpty()
                        if (t.isNotEmpty()) event("speech-final", t)
                        // Single shot: the session is over — reset the toggle.
                        dictating = false
                        event("status", "")
                        event("dictation", "off")
                    }
                    override fun onError(error: Int) {
                        dictating = false
                        event("status", "")
                        event("dictation", "off")   // tell the UI to reset the mic
                    }
                    override fun onReadyForSpeech(params: Bundle?) { event("status", "Listening…") }
                    override fun onEndOfSpeech() {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onPartialResults(partialResults: Bundle?) {
                        val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull()?.trim().orEmpty()
                        if (t.isNotEmpty()) event("speech-partial", t)
                    }
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
            }
        }
        speechIntent = buildSpeechIntent()
        // Cancel any lingering session first — a busy recognizer silently ignores
        // startListening, which is why the button sometimes needed two presses.
        try { speech?.cancel() } catch (_: Throwable) {}
        try { speech?.startListening(speechIntent) } catch (_: Throwable) {}
    }

    private fun stopDictation() {
        dictating = false
        try { speech?.cancel() } catch (_: Throwable) {}
        event("status", "")
    }

    override fun onDestroy() {
        dictating = false
        speech?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val REPO = "efficientengineer/mobilecode"
        private const val NOTIFY_CHANNEL = "agent_replies"
        private const val NOTIFY_ID = 42

        // Trailing silence (ms) before the recognizer may end. ~7s so natural
        // pauses don't cut you off (also backed by auto-restart).
        private const val SPEECH_SILENCE_MS = 7000

        // Number of agent runs in flight; survives Activity recreation.
        @Volatile private var activeRuns = 0

        /** Foreground agent runs in flight — the PR watcher skips auto-fix while
         *  one is active to avoid two loops sharing a workspace. */
        @JvmStatic
        fun runsActive(): Int = activeRuns
    }
}
