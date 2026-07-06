package com.voiceagent.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.view.Menu
import android.view.MenuItem
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.voiceagent.app.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var sessions: SessionManager
    private var speech: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private val transcript = StringBuilder()

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                Toast.makeText(this, "Microphone permission is required", Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)

        sessions = SessionManager(this)

        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }
        prepareWorkspaceEnv()

        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) tts?.language = Locale.getDefault()
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }

        binding.micButton.setOnClickListener { startListening() }

        appendLine("Ready. Tap the mic and speak a coding task.")
        refreshSessionBar()
        maybePromptForKeys()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.action_files -> startActivity(Intent(this, FilesActivity::class.java))
            R.id.action_commit -> runOrchestrator("commit_now")
            R.id.action_push -> runGit("Push") { it.callAttr("push").toString() }
            R.id.action_pull -> runGit("Pull") { it.callAttr("pull").toString() }
            R.id.action_new_repo -> newRepoDialog()
            R.id.action_switch_repo -> switchRepoDialog()
            R.id.action_sessions -> sessionsDialog()
            R.id.action_settings -> showKeyDialog()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    // --- Environment ------------------------------------------------------

    private fun prepareWorkspaceEnv() {
        val ws = sessions.activeDir()
        val py = Python.getInstance()
        val os = py.getModule("os")
        fun set(k: String, v: String) = os.get("environ")?.callAttr("__setitem__", k, v)
        set("AGENT_WORKSPACE", ws.absolutePath)
        set("HOME", filesDir.absolutePath)
        set("AGENT_OVERRIDE", overrideFile().absolutePath)

        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        prefs.getString("ANTHROPIC_API_KEY", null)?.let { set("ANTHROPIC_API_KEY", it) }
        prefs.getString("DEEPSEEK_API_KEY", null)?.let { set("DEEPSEEK_API_KEY", it) }
        prefs.getString("GITHUB_TOKEN", null)?.let { set("GITHUB_TOKEN", it) }
        val lead = prefs.getString("LEAD_MODEL", null)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.lead_model_default)
        set("LEAD_MODEL", lead)
        // Implementer may be blank → single-agent mode; pass it through as-is.
        set("WORKER_MODEL", prefs.getString("WORKER_MODEL", "").orEmpty())
    }

    private fun overrideFile(): File =
        File(File(filesDir, "py_override").apply { mkdirs() }, "orchestrator.py")

    private fun refreshSessionBar() {
        val m = sessions.readMeta(sessions.activeId())
        val repo = if (m.activeRepo.isBlank()) "no repo" else m.activeRepo
        binding.sessionText.text = "Session: ${m.name}  •  $repo"
    }

    // --- Voice input ------------------------------------------------------

    private fun startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            Toast.makeText(this, "Speech recognition unavailable on this device",
                Toast.LENGTH_LONG).show()
            return
        }
        speech?.destroy()
        speech = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle?) {
                    val text = results
                        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()
                        ?.trim()
                        .orEmpty()
                    if (text.isNotEmpty()) {
                        appendLine("You: $text")
                        runAgent(text)
                    }
                }
                override fun onError(error: Int) {
                    appendLine("(didn't catch that — tap and try again)")
                }
                override fun onReadyForSpeech(params: Bundle?) {
                    binding.statusText.text = getString(R.string.listening)
                }
                override fun onEndOfSpeech() {
                    binding.statusText.text = getString(R.string.thinking)
                }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        }
        speech?.startListening(intent)
    }

    // --- Agent call -------------------------------------------------------

    private fun runAgent(task: String) {
        binding.micButton.isEnabled = false
        binding.statusText.text = getString(R.string.thinking)
        val id = sessions.activeId()
        sessions.appendTurn(id, "user", task)
        // Feed recent transcript to the planner via env (read in orchestrator).
        val os = Python.getInstance().getModule("os")
        os.get("environ")?.callAttr("__setitem__", "AGENT_CONTEXT", sessions.recentContext(id))
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    Python.getInstance()
                        .getModule("agent_loader")
                        .callAttr("run_task", task)
                        .toString()
                } catch (e: Throwable) {
                    "Error: ${e.message}"
                }
            }
            sessions.appendTurn(id, "agent", result)
            appendLine("Agent: $result")
            speak(result.lineSequence().firstOrNull() ?: "Done")
            binding.micButton.isEnabled = true
            binding.statusText.text = getString(R.string.ready)
        }
    }

    /** Call a no-arg function on the bundled orchestrator (e.g. commit_now). */
    private fun runOrchestrator(fn: String) {
        binding.statusText.text = getString(R.string.thinking)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    Python.getInstance().getModule("orchestrator").callAttr(fn).toString()
                } catch (e: Throwable) {
                    "Error: ${e.message}"
                }
            }
            appendLine(result)
            binding.statusText.text = getString(R.string.ready)
        }
    }

    /** Run a git_ops action off the main thread and report the result. */
    private fun runGit(label: String, block: (com.chaquo.python.PyObject) -> String) {
        appendLine("$label…")
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    block(Python.getInstance().getModule("git_ops"))
                } catch (e: Throwable) {
                    "$label failed: ${e.message}"
                }
            }
            appendLine(result)
            Toast.makeText(this@MainActivity, result.lineSequence().first(), Toast.LENGTH_LONG).show()
        }
    }

    // --- Repos ------------------------------------------------------------

    private fun newRepoDialog() {
        val input = EditText(this).apply { hint = "repo-name" }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("New GitHub repo")
            .setView(input)
            .setPositiveButton("Create") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isBlank()) return@setPositiveButton
                runGit("Create repo") { g ->
                    val r = g.callAttr("create_repo", name, true).toString()
                    if (r.startsWith("Created ")) {
                        val full = r.removePrefix("Created ").trim()
                        sessions.setActiveRepo(sessions.activeId(), full)
                        runOnUiThread { refreshSessionBar() }
                    }
                    r
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun switchRepoDialog() {
        appendLine("Loading repos…")
        lifecycleScope.launch {
            val names = withContext(Dispatchers.IO) {
                try {
                    val json = Python.getInstance().getModule("git_ops")
                        .callAttr("list_repos").toString()
                    val arr = JSONArray(json)
                    (0 until arr.length()).map { arr.getString(it) }
                } catch (e: Throwable) {
                    emptyList()
                }
            }
            if (names.isEmpty()) {
                appendLine("No repos found (check your GitHub token).")
                return@launch
            }
            androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                .setTitle("Switch repo")
                .setItems(names.toTypedArray()) { _, which ->
                    confirmCloneDialog(names[which])
                }
                .show()
        }
    }

    private fun confirmCloneDialog(full: String) {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(full)
            .setMessage("Clone this repo into the current session? This replaces the session's local files.")
            .setPositiveButton("Clone") { _, _ ->
                runGit("Clone") { g ->
                    val r = g.callAttr("clone_repo", full).toString()
                    sessions.setActiveRepo(sessions.activeId(), full)
                    runOnUiThread { refreshSessionBar() }
                    r
                }
            }
            .setNeutralButton("Just point at it") { _, _ ->
                runGit("Set repo") { g ->
                    val r = g.callAttr("set_active_repo", full).toString()
                    sessions.setActiveRepo(sessions.activeId(), full)
                    runOnUiThread { refreshSessionBar() }
                    r
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // --- Sessions ---------------------------------------------------------

    private fun sessionsDialog() {
        val all = sessions.list()
        val labels = all.map {
            (if (it.id == sessions.activeId()) "● " else "○ ") +
                it.name + (if (it.activeRepo.isNotBlank()) "  (${it.activeRepo})" else "")
        }.toTypedArray()
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Sessions")
            .setItems(labels) { _, which ->
                sessions.setActive(all[which].id)
                prepareWorkspaceEnv()
                refreshSessionBar()
                appendLine("Switched to session: ${all[which].name}")
            }
            .setNeutralButton("New session") { _, _ -> newSessionDialog() }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun newSessionDialog() {
        val input = EditText(this).apply { hint = "session name" }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("New session")
            .setView(input)
            .setPositiveButton("Create") { _, _ ->
                val id = sessions.create(input.text.toString().trim())
                sessions.setActive(id)
                prepareWorkspaceEnv()
                refreshSessionBar()
                appendLine("Created session.")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // --- Output helpers ---------------------------------------------------

    private fun speak(text: String) {
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "agent")
    }

    private fun appendLine(line: String) {
        transcript.append(line).append("\n\n")
        binding.transcriptView.text = transcript.toString()
        binding.transcriptScroll.post {
            binding.transcriptScroll.fullScroll(android.view.View.FOCUS_DOWN)
        }
    }

    // --- Settings ---------------------------------------------------------

    private fun maybePromptForKeys() {
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        if (prefs.getString("ANTHROPIC_API_KEY", null).isNullOrBlank() ||
            prefs.getString("DEEPSEEK_API_KEY", null).isNullOrBlank()) {
            appendLine("Tap the menu → Settings to add your API keys.")
        }
    }

    private fun showKeyDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_keys, null)
        val anthropicField = view.findViewById<EditText>(R.id.anthropicKey)
        val deepseekField = view.findViewById<EditText>(R.id.deepseekKey)
        val leadField = view.findViewById<AutoCompleteTextView>(R.id.leadModel)
        val workerField = view.findViewById<AutoCompleteTextView>(R.id.workerModel)
        val tokenField = view.findViewById<EditText>(R.id.githubToken)
        val branchField = view.findViewById<EditText>(R.id.agentBranch)
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)

        anthropicField.setText(prefs.getString("ANTHROPIC_API_KEY", ""))
        deepseekField.setText(prefs.getString("DEEPSEEK_API_KEY", ""))
        leadField.setText(
            prefs.getString("LEAD_MODEL", "")?.takeIf { it.isNotBlank() }
                ?: getString(R.string.lead_model_default)
        )
        workerField.setText(prefs.getString("WORKER_MODEL", ""))
        tokenField.setText(prefs.getString("GITHUB_TOKEN", ""))
        branchField.setText(
            prefs.getString("AGENT_BRANCH", "")?.takeIf { it.isNotBlank() }
                ?: getString(R.string.agent_branch_default)
        )

        fun persist() {
            prefs.edit()
                .putString("ANTHROPIC_API_KEY", anthropicField.text.toString().trim())
                .putString("DEEPSEEK_API_KEY", deepseekField.text.toString().trim())
                .putString("LEAD_MODEL", leadField.text.toString().trim())
                .putString("WORKER_MODEL", workerField.text.toString().trim())
                .putString("GITHUB_TOKEN", tokenField.text.toString().trim())
                .putString("AGENT_BRANCH", branchField.text.toString().trim())
                .apply()
            prepareWorkspaceEnv()
        }

        leadField.setOnClickListener { leadField.showDropDown() }
        workerField.setOnClickListener { workerField.showDropDown() }
        populateModels(leadField, prefs.getString("ANTHROPIC_API_KEY", "").orEmpty()) {
            fetchAnthropicModels(it)
        }
        populateModels(workerField, prefs.getString("DEEPSEEK_API_KEY", "").orEmpty()) {
            fetchDeepseekModels(it)
        }

        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Settings")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                persist()
                Toast.makeText(this, "Settings saved", Toast.LENGTH_SHORT).show()
            }
            .setNeutralButton(getString(R.string.update_agent)) { _, _ ->
                persist()
                updateAgentCode(
                    tokenField.text.toString().trim(),
                    branchField.text.toString().trim()
                        .ifBlank { getString(R.string.agent_branch_default) }
                )
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun updateAgentCode(token: String, branch: String) {
        if (token.isBlank()) {
            Toast.makeText(this, "Add a GitHub token first", Toast.LENGTH_LONG).show()
            return
        }
        Toast.makeText(this, "Updating agent…", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val outcome = withContext(Dispatchers.IO) {
                try {
                    val url = URL(
                        "https://api.github.com/repos/$AGENT_REPO/contents/" +
                            "$AGENT_FILE_PATH?ref=$branch"
                    )
                    val conn = (url.openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        setRequestProperty("Authorization", "Bearer $token")
                        setRequestProperty("Accept", "application/vnd.github.raw")
                        setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
                        connectTimeout = 20000
                        readTimeout = 20000
                    }
                    conn.use {
                        if (it.responseCode == 200) {
                            val body = it.inputStream.bufferedReader().use { r -> r.readText() }
                            overrideFile().writeText(body)
                            "Agent updated — next task uses the new code"
                        } else {
                            "Update failed: HTTP ${it.responseCode}"
                        }
                    }
                } catch (e: Throwable) {
                    "Update failed: ${e.message}"
                }
            }
            appendLine(outcome)
            Toast.makeText(this@MainActivity, outcome, Toast.LENGTH_LONG).show()
        }
    }

    private fun populateModels(
        field: AutoCompleteTextView,
        key: String,
        fetch: (String) -> List<String>
    ) {
        if (key.isBlank()) return
        lifecycleScope.launch {
            val models = withContext(Dispatchers.IO) {
                try {
                    fetch(key)
                } catch (e: Throwable) {
                    emptyList()
                }
            }
            if (models.isNotEmpty()) {
                field.setAdapter(
                    ArrayAdapter(
                        this@MainActivity,
                        android.R.layout.simple_dropdown_item_1line,
                        models
                    )
                )
            }
        }
    }

    private fun fetchAnthropicModels(key: String): List<String> {
        val conn = (URL("https://api.anthropic.com/v1/models?limit=100").openConnection()
                as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("x-api-key", key)
            setRequestProperty("anthropic-version", "2023-06-01")
            connectTimeout = 15000
            readTimeout = 15000
        }
        return conn.use { readModelIds(it, "anthropic/") }
    }

    private fun fetchDeepseekModels(key: String): List<String> {
        val conn = (URL("https://api.deepseek.com/v1/models").openConnection()
                as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("Authorization", "Bearer $key")
            connectTimeout = 15000
            readTimeout = 15000
        }
        return conn.use { readModelIds(it, "deepseek/") }
    }

    private fun readModelIds(conn: HttpURLConnection, prefix: String): List<String> {
        if (conn.responseCode != 200) return emptyList()
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        val data = JSONObject(body).optJSONArray("data") ?: return emptyList()
        return (0 until data.length()).mapNotNull { i ->
            data.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }
        }.map { "$prefix$it" }
    }

    private inline fun <T> HttpURLConnection.use(block: (HttpURLConnection) -> T): T {
        try {
            return block(this)
        } finally {
            disconnect()
        }
    }

    override fun onDestroy() {
        speech?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val AGENT_REPO = "efficientengineer/mobilecode"
        private const val AGENT_FILE_PATH = "app/src/main/python/orchestrator.py"
    }
}
