package com.voiceagent.app

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Sessions are self-contained folders under filesDir/sessions/<id>/:
 *   - the folder itself is the git workspace (the repo lives here)
 *   - meta.json holds { name, activeRepo }
 *   - transcript.jsonl holds one JSON object per turn
 *
 * The active session id is stored in SharedPreferences; the active session's
 * folder is what gets passed to Python as AGENT_WORKSPACE.
 */
class SessionManager(private val ctx: Context) {

    private val root = File(ctx.filesDir, "sessions").apply { mkdirs() }
    private val prefs = ctx.getSharedPreferences("session", Context.MODE_PRIVATE)

    data class Session(val id: String, val name: String, val activeRepo: String)

    fun activeId(): String {
        val id = prefs.getString("active", null)
        if (id != null && File(root, id).isDirectory) return id
        // First run (or stale id): create/adopt a default session.
        val existing = list().firstOrNull()
        val chosen = existing?.id ?: create("default")
        setActive(chosen)
        return chosen
    }

    fun activeDir(): File = File(root, activeId()).apply { mkdirs() }

    fun setActive(id: String) {
        prefs.edit().putString("active", id).apply()
    }

    fun list(): List<Session> =
        (root.listFiles()?.filter { it.isDirectory } ?: emptyList())
            .sortedBy { it.name }
            .map { readMeta(it.name) }

    fun create(name: String): String {
        val id = "s_" + System.currentTimeMillis().toString()
        val dir = File(root, id).apply { mkdirs() }
        writeMeta(dir, name.ifBlank { id }, "")
        return id
    }

    fun delete(id: String) {
        File(root, id).deleteRecursively()
        if (prefs.getString("active", null) == id) prefs.edit().remove("active").apply()
    }

    fun readMeta(id: String): Session {
        val dir = File(root, id)
        val f = File(dir, "meta.json")
        return if (f.exists()) {
            val o = JSONObject(f.readText())
            Session(id, o.optString("name", id), o.optString("activeRepo", ""))
        } else {
            Session(id, id, "")
        }
    }

    fun setActiveRepo(id: String, repo: String) {
        val m = readMeta(id)
        writeMeta(File(root, id), m.name, repo)
    }

    private fun writeMeta(dir: File, name: String, activeRepo: String) {
        dir.mkdirs()
        File(dir, "meta.json").writeText(
            JSONObject().put("name", name).put("activeRepo", activeRepo).toString()
        )
    }

    /** Append one turn to the session transcript. */
    fun appendTurn(id: String, role: String, text: String) {
        val f = File(File(root, id), "transcript.jsonl")
        val line = JSONObject().put("role", role).put("text", text).toString()
        f.appendText(line + "\n")
    }

    /** All turns for a session, oldest first, as (role, text) pairs. */
    fun turns(id: String): List<Pair<String, String>> {
        val f = File(File(root, id), "transcript.jsonl")
        if (!f.exists()) return emptyList()
        return f.readLines().mapNotNull {
            try {
                val o = JSONObject(it)
                o.optString("role") to o.optString("text")
            } catch (e: Throwable) {
                null
            }
        }
    }

    /** The last [n] turns, oldest first, as "role: text" lines for context. */
    fun recentContext(id: String, n: Int = 6): String {
        val f = File(File(root, id), "transcript.jsonl")
        if (!f.exists()) return ""
        val lines = f.readLines().takeLast(n)
        return lines.joinToString("\n") {
            try {
                val o = JSONObject(it)
                "${o.optString("role")}: ${o.optString("text")}"
            } catch (e: Throwable) {
                ""
            }
        }
    }
}
