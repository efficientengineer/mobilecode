package com.voiceagent.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.content.Intent
import android.speech.RecognitionListener
import android.speech.tts.TextToSpeech
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
import java.io.File
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

    // --- Agent call (off the main thread) --------------------------------

    private fun runAgent(task: String) {
        binding.micButton.isEnabled = false
        binding.statusText.text = getString(R.string.thinking)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    Python.getInstance()
                        .getModule("orchestrator")
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
        val anthropicField = view.findViewById<android.widget.EditText>(R.id.anthropicKey)
        val deepseekField = view.findViewById<android.widget.EditText>(R.id.deepseekKey)
        val prefs = getSharedPreferences("keys", MODE_PRIVATE)
        anthropicField.setText(prefs.getString("ANTHROPIC_API_KEY", ""))
        deepseekField.setText(prefs.getString("DEEPSEEK_API_KEY", ""))

        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("API Keys")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                prefs.edit()
                    .putString("ANTHROPIC_API_KEY", anthropicField.text.toString().trim())
                    .putString("DEEPSEEK_API_KEY", deepseekField.text.toString().trim())
                    .apply()
                prepareWorkspaceEnv()
                Toast.makeText(this, "Keys saved", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onDestroy() {
        speech?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }
}
