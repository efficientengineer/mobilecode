package com.voiceagent.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

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

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.webViewClient = WebViewClient()
        web.addJavascriptInterface(Bridge(), "Native")
        setContentView(web)
        loadUi()
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
        getSharedPreferences("keys", MODE_PRIVATE).getString("WORKER_MODEL", "").orEmpty()

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
        set("AGENT_OVERRIDE", File(File(filesDir, "py_override").apply { mkdirs() }, "orchestrator.py").absolutePath)
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        prefs.getString("ANTHROPIC_API_KEY", null)?.let { set("ANTHROPIC_API_KEY", it) }
        prefs.getString("DEEPSEEK_API_KEY", null)?.let { set("DEEPSEEK_API_KEY", it) }
        prefs.getString("GITHUB_TOKEN", null)?.let { set("GITHUB_TOKEN", it) }
        val (lead, worker) = effectiveModels()
        set("LEAD_MODEL", lead)
        set("WORKER_MODEL", worker)
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
            JSONObject().put("name", m.name).put("activeRepo", m.activeRepo)
                .put("orchestrator", lead).put("implementer", worker)
        }
        "session.turns" -> withContext(Dispatchers.IO) {
            val arr = JSONArray()
            sessions.turns(sessions.activeId()).forEach {
                arr.put(JSONObject().put("role", it.first).put("text", it.second))
            }
            JSONObject().put("turns", arr)
        }
        "session.list" -> {
            val arr = JSONArray()
            sessions.list().forEach {
                arr.put(JSONObject().put("id", it.id).put("name", it.name).put("activeRepo", it.activeRepo))
            }
            JSONObject().put("activeId", sessions.activeId()).put("sessions", arr)
        }
        "session.create" -> {
            val id = sessions.create(arg.optString("name"))
            sessions.setActive(id); prepareEnv()
            JSONObject().put("id", id)
        }
        "session.setActive" -> {
            sessions.setActive(arg.getString("id")); prepareEnv()
            JSONObject().put("ok", true)
        }
        "session.setModels" -> {
            sessions.setModels(sessions.activeId(),
                arg.optString("orchestrator").trim(), arg.optString("implementer").trim())
            prepareEnv()
            JSONObject().put("ok", true)
        }
        "agent.run" -> withContext(Dispatchers.IO) {
            val id = sessions.activeId()
            val task = arg.getString("task")
            val mode = arg.optString("mode", "auto")
            sessions.appendTurn(id, "user", task)
            val env = py("os").get("environ")
            env?.callAttr("__setitem__", "AGENT_CONTEXT", sessions.recentContext(id))
            env?.callAttr("__setitem__", "AGENT_MODE", mode)
            val result = py("agent_loader").callAttr("run_task", task).toString()
            sessions.appendTurn(id, "agent", result)
            text(result)
        }
        "plan.approve" -> withContext(Dispatchers.IO) {
            val result = py("agent_loader").callAttr("execute_plan").toString()
            sessions.appendTurn(sessions.activeId(), "agent", result)
            text(result)
        }
        "context.get", "session.turns2" -> withContext(Dispatchers.IO) {
            val arr = JSONArray()
            sessions.turns(sessions.activeId()).forEach {
                arr.put(JSONObject().put("role", it.first).put("text", it.second))
            }
            JSONObject().put("turns", arr)
        }
        "context.clear" -> {
            sessions.clearTranscript(sessions.activeId())
            text("Context cleared")
        }
        "context.trim" -> {
            val keep = arg.optInt("keep", 10)
            sessions.trimTranscript(sessions.activeId(), keep)
            text("Trimmed to last $keep turns")
        }
        "py.call" -> withContext(Dispatchers.IO) {
            // Generic escape hatch: call a bundled Python function from the web
            // layer so future features can ship OTA without a bridge change.
            val a = arg.optJSONArray("args")
            val args: Array<Any?> = if (a == null) arrayOf() else Array(a.length()) { a.get(it) }
            text(py(arg.getString("module")).callAttr(arg.getString("fn"), *args).toString())
        }
        "agent.commit" -> withContext(Dispatchers.IO) { text(py("orchestrator").callAttr("commit_now").toString()) }
        "git.push" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("push").toString()) }
        "git.pull" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("pull").toString()) }
        "git.balances" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("balances").toString()) }
        "git.cloudBuild" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("cloud_build").toString()) }
        "git.buildStatus" -> withContext(Dispatchers.IO) { text(py("git_ops").callAttr("latest_build").toString()) }
        "git.createRepo" -> withContext(Dispatchers.IO) {
            val r = py("git_ops").callAttr("create_repo", arg.getString("name"), true).toString()
            if (r.startsWith("Created ")) sessions.setActiveRepo(sessions.activeId(), r.removePrefix("Created ").trim())
            text(r)
        }
        "git.listRepos" -> withContext(Dispatchers.IO) {
            JSONObject().put("repos", JSONArray(py("git_ops").callAttr("list_repos").toString()))
        }
        "git.clone" -> withContext(Dispatchers.IO) {
            val full = arg.getString("full")
            val r = py("git_ops").callAttr("clone_repo", full).toString()
            sessions.setActiveRepo(sessions.activeId(), full)
            text(r)
        }
        "git.setActiveRepo" -> withContext(Dispatchers.IO) {
            val full = arg.getString("full")
            val r = py("git_ops").callAttr("set_active_repo", full).toString()
            sessions.setActiveRepo(sessions.activeId(), full)
            text(r)
        }
        "fs.tree" -> withContext(Dispatchers.IO) {
            JSONObject().put("files", JSONArray(py("git_ops").callAttr("list_tree").toString()))
        }
        "fs.read" -> withContext(Dispatchers.IO) {
            JSONObject().put("content", py("git_ops").callAttr("read_file", arg.getString("path")).toString())
        }
        "models.aggregate" -> withContext(Dispatchers.IO) {
            JSONObject().put("models", JSONArray(aggregateModels()))
        }
        "settings.get" -> {
            val p = getSharedPreferences("keys", MODE_PRIVATE)
            JSONObject()
                .put("anthropicKey", p.getString("ANTHROPIC_API_KEY", ""))
                .put("deepseekKey", p.getString("DEEPSEEK_API_KEY", ""))
                .put("githubToken", p.getString("GITHUB_TOKEN", ""))
                .put("leadModel", p.getString("LEAD_MODEL", "")?.ifBlank { getString(R.string.lead_model_default) })
                .put("workerModel", p.getString("WORKER_MODEL", ""))
                .put("branch", p.getString("AGENT_BRANCH", "")?.ifBlank { getString(R.string.agent_branch_default) })
        }
        "settings.save" -> {
            getSharedPreferences("keys", MODE_PRIVATE).edit()
                .putString("ANTHROPIC_API_KEY", arg.optString("anthropicKey"))
                .putString("DEEPSEEK_API_KEY", arg.optString("deepseekKey"))
                .putString("GITHUB_TOKEN", arg.optString("githubToken"))
                .putString("LEAD_MODEL", arg.optString("leadModel"))
                .putString("WORKER_MODEL", arg.optString("workerModel"))
                .putString("AGENT_BRANCH", arg.optString("branch"))
                .apply()
            prepareEnv()
            JSONObject().put("ok", true)
        }
        "speak" -> {
            tts?.speak(arg.optString("text"), TextToSpeech.QUEUE_FLUSH, null, "a")
            JSONObject().put("ok", true)
        }
        "listen" -> { withContext(Dispatchers.Main) { startListening() }; JSONObject().put("ok", true) }
        "run" -> { withContext(Dispatchers.Main) { startActivity(Intent(this@MainActivity, RunActivity::class.java)) }; JSONObject().put("ok", true) }
        "updateAgent" -> withContext(Dispatchers.IO) { text(updateAgent()) }
        "updateUI" -> withContext(Dispatchers.IO) { text(updateUI()) }
        else -> JSONObject().put("text", "unknown action: $action")
    }

    // --- OTA updates ------------------------------------------------------

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

    private fun updateAgent(): String = try {
        val body = fetchRaw("app/src/main/python/orchestrator.py")
        File(File(filesDir, "py_override").apply { mkdirs() }, "orchestrator.py").writeText(body)
        "Agent updated — next task uses the new code"
    } catch (e: Throwable) {
        "Update agent failed: ${e.message}"
    }

    private fun updateUI(): String = try {
        val dir = File(filesDir, "web").apply { mkdirs() }
        for (f in listOf("index.html", "style.css", "app.js")) {
            File(dir, f).writeText(fetchRaw("app/src/main/assets/web/$f"))
        }
        runOnUiThread { loadUi() }
        "UI updated"
    } catch (e: Throwable) {
        "Update UI failed: ${e.message}"
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

    private fun startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            event("status", "Speech unavailable")
            return
        }
        speech?.destroy()
        speech = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle?) {
                    val t = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.trim().orEmpty()
                    event("speech-final", t)
                }
                override fun onError(error: Int) { event("status", "") }
                override fun onReadyForSpeech(params: Bundle?) { event("status", "Listening…") }
                override fun onEndOfSpeech() { event("status", "Thinking…") }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        }
        speech?.startListening(intent)
    }

    override fun onDestroy() {
        speech?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val REPO = "efficientengineer/mobilecode"
    }
}
