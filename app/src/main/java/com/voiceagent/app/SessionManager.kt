package com.voiceagent.app

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Sessions are self-contained folders under filesDir/sessions/<id>/:
 *   - the folder itself is the git workspace (the repo lives here)
 *   - meta.json holds { name, activeRepo, models }
 *   - the conversation lives in .agent/discussion.jsonl, owned by the Python
 *     orchestrator (see orchestrator._append_discussion) — NOT here.
 *
 * The active session id is stored in SharedPreferences; the active session's
 * folder is what gets passed to Python as AGENT_WORKSPACE.
 */
class SessionManager(private val ctx: Context) {

    private val root = File(ctx.filesDir, "sessions").apply { mkdirs() }
    private val prefs = ctx.getSharedPreferences("session", Context.MODE_PRIVATE)

    data class Session(
        val id: String,
        val name: String,
        val activeRepo: String,
        val orchestratorModel: String = "",
        val implementerModel: String = "",
        val modelsConfigured: Boolean = false,
    )

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
        File(root, id).mkdirs()
        write(Session(id, name.ifBlank { id }, ""))
        return id
    }

    fun delete(id: String) {
        File(root, id).deleteRecursively()
        if (prefs.getString("active", null) == id) prefs.edit().remove("active").apply()
    }

    fun rename(id: String, name: String) {
        if (name.isBlank()) return
        write(readMeta(id).copy(name = name.trim()))
    }

    fun readMeta(id: String): Session {
        val dir = File(root, id)
        val f = File(dir, "meta.json")
        return if (f.exists()) {
            val o = JSONObject(f.readText())
            Session(
                id,
                o.optString("name", id),
                o.optString("activeRepo", ""),
                o.optString("orchestratorModel", ""),
                o.optString("implementerModel", ""),
                o.optBoolean("modelsConfigured", false),
            )
        } else {
            Session(id, id, "")
        }
    }

    fun setActiveRepo(id: String, repo: String) {
        write(readMeta(id).copy(activeRepo = repo))
    }

    fun setModels(id: String, orchestrator: String, implementer: String) {
        write(readMeta(id).copy(
            orchestratorModel = orchestrator,
            implementerModel = implementer,
            modelsConfigured = true,
        ))
    }

    private fun write(s: Session) {
        File(root, s.id).mkdirs()
        File(File(root, s.id), "meta.json").writeText(
            JSONObject()
                .put("name", s.name)
                .put("activeRepo", s.activeRepo)
                .put("orchestratorModel", s.orchestratorModel)
                .put("implementerModel", s.implementerModel)
                .put("modelsConfigured", s.modelsConfigured)
                .toString()
        )
    }
}
