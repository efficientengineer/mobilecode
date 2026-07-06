package com.voiceagent.app

import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.google.android.material.appbar.MaterialToolbar
import org.json.JSONArray

/**
 * A simple browsable file view over the active workspace. It reads the flat
 * list of relative paths from git_ops.list_tree and reconstructs a folder tree
 * in-app, so navigation costs no extra Python calls. Tapping a file shows its
 * contents.
 */
class FilesActivity : AppCompatActivity() {

    private var allPaths: List<String> = emptyList()
    private var currentPath: String = ""   // "" or "dir/sub/"
    private lateinit var listView: ListView
    private lateinit var pathText: TextView
    private var entries: List<String> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_files)

        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        setWorkspaceEnv()

        val toolbar = findViewById<MaterialToolbar>(R.id.filesToolbar)
        toolbar.title = "Files"
        toolbar.setNavigationOnClickListener { goUp() }

        pathText = findViewById(R.id.pathText)
        listView = findViewById(R.id.fileList)
        listView.setOnItemClickListener { _, _, pos, _ -> onEntry(entries[pos]) }

        allPaths = loadPaths()
        render()
    }

    /** Point Python at the active session's workspace before listing. */
    private fun setWorkspaceEnv() {
        val ws = SessionManager(this).activeDir().absolutePath
        val os = Python.getInstance().getModule("os")
        os.get("environ")?.callAttr("__setitem__", "AGENT_WORKSPACE", ws)
    }

    private fun loadPaths(): List<String> {
        return try {
            val json = Python.getInstance().getModule("git_ops")
                .callAttr("list_tree").toString()
            val arr = JSONArray(json)
            (0 until arr.length()).map { arr.getString(it) }
        } catch (e: Throwable) {
            emptyList()
        }
    }

    private fun render() {
        pathText.text = "/" + currentPath
        val dirs = sortedSetOf<String>()
        val files = mutableListOf<String>()
        for (p in allPaths) {
            if (!p.startsWith(currentPath)) continue
            val rest = p.removePrefix(currentPath)
            if (rest.isEmpty()) continue
            val slash = rest.indexOf('/')
            if (slash >= 0) dirs.add(rest.substring(0, slash) + "/")
            else files.add(rest)
        }
        entries = dirs.toList() + files.sorted()
        val shown = if (entries.isEmpty()) listOf("(empty)") else entries
        listView.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, shown)
    }

    private fun onEntry(entry: String) {
        if (entry == "(empty)") return
        if (entry.endsWith("/")) {
            currentPath += entry
            render()
        } else {
            showFile(currentPath + entry)
        }
    }

    private fun showFile(rel: String) {
        val content = try {
            Python.getInstance().getModule("git_ops")
                .callAttr("read_file", rel).toString()
        } catch (e: Throwable) {
            "Could not read file: ${e.message}"
        }
        val tv = TextView(this).apply {
            text = if (content.isEmpty()) "(empty file)" else content
            setTextIsSelectable(true)
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 13f
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
        }
        val scroll = ScrollView(this).apply { addView(tv) }
        AlertDialog.Builder(this)
            .setTitle(rel)
            .setView(scroll)
            .setPositiveButton("Close", null)
            .show()
    }

    private fun goUp() {
        if (currentPath.isEmpty()) {
            finish()
            return
        }
        val trimmed = currentPath.trimEnd('/')
        currentPath = if (trimmed.contains('/'))
            trimmed.substringBeforeLast('/') + "/" else ""
        render()
    }

    override fun onBackPressed() {
        if (currentPath.isEmpty()) super.onBackPressed() else goUp()
    }
}
