package com.voiceagent.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.content.Intent
import android.speech.RecognitionListener
import android.speech.tts.TextToSpeech
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
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
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

        // 1. Start the embedded Python runtime (Chaquopy).
        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }
        prepareWorkspaceEnv()

        // 2. Text-to-speech for hands-free responses.
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.getDefault()
            }
        }

        // 3. Ask for mic permission up front.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }

        binding.micButton.setOnClickListener { startListening() }
        binding.settingsButton.setOnClickListener { showKeyDialog() }

        appendLine("Ready. Tap the mic and speak a coding task.")
        maybePromptForKeys()
    }

    /**
     * Point the Python side at a writable repo dir inside app storage.
     * (CWD is read-only on Android — this is mandatory.)
     */
    private fun prepareWorkspaceEnv() {
        val ws = File(filesDir, "workspace").apply { mkdirs() }
        val py = Python.getInstance()
        val os = py.getModule("os")
        os.get("environ")?.callAttr("__setitem__", "AGENT_WORKSPACE", ws.absolutePath)
        os.get("environ")?.callAttr("__setitem__", "HOME", filesDir.absolutePath)
        // Inject user-provided API keys (stored in SharedPreferences).
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        prefs.getString("ANTHROPIC_API_KEY", null)?.let {
            os.get("environ")?.callAttr("__setitem__", "ANTHROPIC_API_KEY", it)
        }
        prefs.getString("DEEPSEEK_API_KEY", null)?.let {
            os.get("environ")?.callAttr("__setitem__", "DEEPSEEK_API_KEY", it)
        }
        // Model overrides. Fall back to the defaults so the Python side always
        // has an explicit, valid model string to route with.
        val lead = prefs.getString("LEAD_MODEL", null)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.lead_model_default)
        val worker = prefs.getString("WORKER_MODEL", null)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.worker_model_default)
        os.get("environ")?.callAttr("__setitem__", "LEAD_MODEL", lead)
        os.get("environ")?.callAttr("__setitem__", "WORKER_MODEL", worker)
        // Where an over-the-air agent update is stored; agent_loader.py runs
        // this file instead of the bundled orchestrator when present.
        os.get("environ")?.callAttr("__setitem__", "AGENT_OVERRIDE", overrideFile().absolutePath)
    }

    /** Location of the hot-updatable orchestrator.py in private storage. */
    private fun overrideFile(): File =
        File(File(filesDir, "py_override").apply { mkdirs() }, "orchestrator.py")

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

    // --- Agent call (off the main thread) --------------------------------

    private fun runAgent(task: String) {
        binding.micButton.isEnabled = false
        binding.statusText.text = getString(R.string.thinking)
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
            appendLine("Agent: $result")
            speak(result.lineSequence().firstOrNull() ?: "Done")
            binding.micButton.isEnabled = true
            binding.statusText.text = getString(R.string.ready)
        }
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

    // --- API key entry ----------------------------------------------------

    private fun maybePromptForKeys() {
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        if (prefs.getString("ANTHROPIC_API_KEY", null).isNullOrBlank() ||
            prefs.getString("DEEPSEEK_API_KEY", null).isNullOrBlank()) {
            appendLine("Tap the gear icon to add your Anthropic and DeepSeek API keys.")
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
        workerField.setText(
            prefs.getString("WORKER_MODEL", "")?.takeIf { it.isNotBlank() }
                ?: getString(R.string.worker_model_default)
        )
        tokenField.setText(prefs.getString("GITHUB_TOKEN", ""))
        branchField.setText(
            prefs.getString("AGENT_BRANCH", "")?.takeIf { it.isNotBlank() }
                ?: getString(R.string.agent_branch_default)
        )

        // Persist all fields to SharedPreferences (shared by Save and Update).
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

        // Tapping the field pops the suggestion list (dropdown behaviour) once
        // it has been populated; until then it's just an editable text box.
        leadField.setOnClickListener { leadField.showDropDown() }
        workerField.setOnClickListener { workerField.showDropDown() }

        // Populate the dropdowns from each provider using the saved keys.
        // Falls back silently to plain text entry when a key is missing, the
        // device is offline, or the request fails.
        populateModels(
            leadField,
            prefs.getString("ANTHROPIC_API_KEY", "").orEmpty()
        ) { key -> fetchAnthropicModels(key) }
        populateModels(
            workerField,
            prefs.getString("DEEPSEEK_API_KEY", "").orEmpty()
        ) { key -> fetchDeepseekModels(key) }

        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Settings")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                persist()
                Toast.makeText(this, "Settings saved", Toast.LENGTH_SHORT).show()
            }
            .setNeutralButton(getString(R.string.update_agent)) { _, _ ->
                // Save first so the fetch uses the current token/branch.
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

    /**
     * Download the latest orchestrator.py from the repo into the override slot,
     * so the agent brain updates over the air with no reinstall. The next task
     * runs the new file. Uses the GitHub contents API (works for private repos
     * with a token that has read access to repo contents).
     */
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

    /** Fetch a provider's model list off the main thread and fill the dropdown. */
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

    /** Anthropic Models API → ids prefixed with "anthropic/" for the router. */
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

    /** DeepSeek Models API (OpenAI-compatible) → ids prefixed with "deepseek/". */
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

    /** Parse a `{ "data": [ { "id": ... } ] }` body into prefixed model ids. */
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
