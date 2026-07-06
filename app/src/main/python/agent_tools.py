"""
agent_tools.py — the tool belt for the agentic loop.

Each tool operates strictly inside the active workspace (env AGENT_WORKSPACE).
Executors return plain strings (what the model sees). The loop tracks which
files were touched via TOUCHED so verification can target them.

Tools:
  read_file, list_files, grep          — inspection (safe in plan mode)
  write_file, str_replace, delete_file — mutation
  check_python                         — compile-check .py files (no execution)
  run_tests                            — in-process unittest discovery
  delegate_edit                        — hand one file edit to the cheap
                                         implementer model (SEARCH/REPLACE)
"""

import io
import os
import re
import json
import fnmatch
from pathlib import Path

import llm

# Relative paths of files created/modified during the current run.
TOUCHED = set()


def reset_touched() -> None:
    TOUCHED.clear()


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    p = Path(ws)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _resolve(rel: str) -> Path:
    """Resolve a relative path inside the workspace; refuse escapes."""
    root = _workspace().resolve()
    fp = (root / str(rel)).resolve()
    if root != fp and root not in fp.parents:
        raise ValueError(f"path escapes the workspace: {rel}")
    return fp


_SKIP_DIRS = {".git", ".agent", "__pycache__", "node_modules"}


def _iter_files(root: Path):
    for p in sorted(root.rglob("*")):
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.name in ("meta.json", "transcript.jsonl"):
            continue
        if p.is_file():
            yield p


# --- inspection --------------------------------------------------------------

def t_read_file(path="", start_line=0, end_line=0, **_):
    fp = _resolve(path)
    if not fp.exists() or not fp.is_file():
        return f"(no such file: {path})"
    try:
        text = fp.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"(unreadable: {e})"
    lines = text.splitlines()
    s = max(1, int(start_line or 1))
    e = int(end_line or 0) or len(lines)
    picked = lines[s - 1:e]
    if len(picked) > 800:
        picked = picked[:800] + [f"…({len(lines)} lines total; request a range for more)"]
    return "\n".join(f"{i + s}\t{l}" for i, l in enumerate(picked)) or "(empty file)"


def t_list_files(pattern="", **_):
    root = _workspace()
    out = []
    for p in _iter_files(root):
        rel = str(p.relative_to(root))
        if pattern and not fnmatch.fnmatch(rel, pattern):
            continue
        try:
            size = p.stat().st_size
        except Exception:
            size = 0
        out.append(f"{rel} ({size}b)")
        if len(out) >= 400:
            out.append("…(truncated at 400 entries; use a pattern)")
            break
    return "\n".join(out) or "(workspace is empty)"


def t_grep(pattern="", glob="", **_):
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return f"(bad regex: {e})"
    root = _workspace()
    hits = []
    for p in _iter_files(root):
        rel = str(p.relative_to(root))
        if glob and not fnmatch.fnmatch(rel, glob):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                hits.append(f"{rel}:{n}: {line.strip()[:200]}")
                if len(hits) >= 200:
                    hits.append("…(truncated at 200 matches)")
                    return "\n".join(hits)
    return "\n".join(hits) or "(no matches)"


# --- web fetch (read-only, provider-agnostic) --------------------------------

_TAG_RE = re.compile(r"(?is)<(script|style)\b.*?</\1>")
_BLOCK_RE = re.compile(r"(?i)</(p|div|section|article|h[1-6]|li|tr|br|table|ul|ol|pre|blockquote)>")
_ANYTAG_RE = re.compile(r"(?s)<[^>]+>")


def _html_to_text(html: str) -> str:
    """Very small HTML→text pass: drop script/style, turn block-ends into
    newlines, strip remaining tags, unescape entities. No dependency."""
    import html as _html
    t = _TAG_RE.sub(" ", html)
    t = _BLOCK_RE.sub("\n", t)
    t = _ANYTAG_RE.sub("", t)
    t = _html.unescape(t)
    lines = [ln.strip() for ln in t.splitlines()]
    out, blank = [], False
    for ln in lines:
        if ln:
            out.append(ln)
            blank = False
        elif not blank:
            out.append("")
            blank = True
    return "\n".join(out).strip()


def t_web_fetch(url="", max_chars=20000, **_):
    """Fetch a URL and return its text (HTML reduced to readable text).

    Stdlib-only (urllib), so it works identically whichever model drives.
    """
    import urllib.request
    import urllib.error
    url = str(url).strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return "(url must start with http:// or https://)"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (voice-agent)",
        "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            raw = resp.read(4_000_000)  # 4 MB cap
    except urllib.error.HTTPError as e:
        return f"(HTTP {e.code} fetching {url})"
    except Exception as e:
        return f"({type(e).__name__} fetching {url}: {e})"
    charset = "utf-8"
    if "charset=" in ctype:
        charset = ctype.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
    try:
        body = raw.decode(charset, errors="replace")
    except Exception:
        body = raw.decode("utf-8", errors="replace")
    if "html" in ctype or (not ctype and "<html" in body[:2000].lower()):
        body = _html_to_text(body)
    try:
        limit = int(max_chars)
    except Exception:
        limit = 20000
    limit = max(1000, min(limit, 100000))
    clipped = len(body) > limit
    return (f"URL: {url}\n\n" + body[:limit] +
            (f"\n\n…[truncated at {limit} chars of {len(body)}]" if clipped else ""))


# --- mutation ------------------------------------------------------------

def t_write_file(path="", content="", **_):
    fp = _resolve(path)
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(content, encoding="utf-8")
    TOUCHED.add(str(path))
    return f"wrote {path} ({len(content)} chars)"


def t_str_replace(path="", old="", new="", replace_all=False, **_):
    fp = _resolve(path)
    if not fp.exists():
        return f"(no such file: {path} — use write_file to create it)"
    text = fp.read_text(encoding="utf-8", errors="replace")
    if old == "":
        return "(old must be non-empty; use write_file for full rewrites)"
    count = text.count(old)
    if count == 0:
        return (f"(no match in {path} — the `old` text must appear verbatim; "
                "read the file again to get exact contents)")
    if count > 1 and not replace_all:
        return (f"({count} matches in {path} — make `old` more specific or set "
                "replace_all)")
    text = text.replace(old, new) if replace_all else text.replace(old, new, 1)
    fp.write_text(text, encoding="utf-8")
    TOUCHED.add(str(path))
    return f"replaced {count if replace_all else 1} occurrence(s) in {path}"


def t_delete_file(path="", **_):
    fp = _resolve(path)
    if not fp.exists():
        return f"(no such file: {path})"
    fp.unlink()
    TOUCHED.add(str(path))
    return f"deleted {path}"


# --- verification ----------------------------------------------------------

def check_python_files(paths=None) -> str:
    """Compile-check .py files (syntax only, nothing executed).

    paths=None checks every touched .py file; returns "" when clean.
    """
    root = _workspace()
    if paths is None:
        paths = [p for p in TOUCHED if p.endswith(".py")]
    errs = []
    for rel in paths:
        fp = root / rel
        if not fp.exists() or not rel.endswith(".py"):
            continue
        try:
            src = fp.read_text(encoding="utf-8", errors="replace")
            compile(src, rel, "exec")
        except SyntaxError as e:
            errs.append(f"{rel}:{e.lineno}: {e.msg}\n    {(e.text or '').rstrip()}")
        except Exception as e:
            errs.append(f"{rel}: {e}")
    return "\n".join(errs)


def t_check_python(paths="", **_):
    lst = [p.strip() for p in str(paths).split(",") if p.strip()] or None
    errs = check_python_files(lst)
    return errs or "OK — no syntax errors"


TEST_TIMEOUT = int(os.environ.get("AGENT_TEST_TIMEOUT", "30"))


def run_tests_status(pattern="test*.py"):
    """Run unittest discovery in-process on a daemon thread with a timeout.

    Returns (ran: bool, ok: bool, output: str). A hung test (infinite loop)
    times out instead of freezing the interpreter thread the UI waits on; the
    stray thread is daemon so it can't keep the process alive.
    """
    import unittest
    import threading
    root = str(_workspace())
    holder = {}

    def _work():
        stream = io.StringIO()
        try:
            loader = unittest.TestLoader()
            suite = loader.discover(root, pattern=pattern or "test*.py",
                                    top_level_dir=root)
            n = suite.countTestCases()
            if n == 0:
                holder["res"] = (False, True, f"(no tests found matching {pattern})")
                return
            result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
            ok = result.wasSuccessful()
            verdict = "PASSED" if ok else "FAILED"
            holder["res"] = (True, ok,
                             f"{verdict}: {result.testsRun} tests, "
                             f"{len(result.failures)} failures, "
                             f"{len(result.errors)} errors\n" + stream.getvalue()[-4000:])
        except Exception as e:
            holder["res"] = (True, False,
                             f"test run crashed: {e}\n{stream.getvalue()[-2000:]}")

    t = threading.Thread(target=_work, daemon=True)
    t.start()
    t.join(TEST_TIMEOUT)
    if t.is_alive():
        return (True, False,
                f"TIMEOUT: tests did not finish within {TEST_TIMEOUT}s "
                "(possible infinite loop). Check for a non-terminating test.")
    return holder.get("res", (False, True, "(no tests ran)"))


def t_run_tests(pattern="test*.py", **_):
    """Run unittest discovery in-process and return the tail of the output.

    Runs on the embedded interpreter (no subprocess on Android), so only
    pure-Python tests work — which matches what this device can build anyway.
    Bounded by AGENT_TEST_TIMEOUT (default 30s).
    """
    _, _, out = run_tests_status(pattern)
    return out


# --- delegate to the implementer model --------------------------------------

_SR_RE = re.compile(
    r"<{5,}\s*SEARCH\s*\n(.*?)\n?={5,}\s*\n(.*?)\n?>{5,}\s*REPLACE", re.S)


def apply_sr_blocks(current: str, text: str):
    """Apply SEARCH/REPLACE blocks. Returns (new, applied, total) or None."""
    blocks = _SR_RE.findall(text)
    if not blocks:
        return None
    new, applied = current, 0
    for search, replace in blocks:
        if search.strip() == "":
            new = (new + ("\n" if new and not new.endswith("\n") else "")) + replace
            applied += 1
        elif search in new:
            new = new.replace(search, replace, 1)
            applied += 1
    return new, applied, len(blocks)


def t_delegate_edit(path="", instruction="", **_):
    """Hand one file edit to the cheap implementer model (SEARCH/REPLACE).

    Lets an expensive orchestrator (e.g. Claude) delegate mechanical edits to
    DeepSeek — or vice versa. Retries once when blocks fail to apply.
    """
    worker = (os.environ.get("WORKER_MODEL") or "").strip()
    if not worker:
        return "(no implementer model configured — edit the file yourself)"
    fp = _resolve(path)
    current = fp.read_text(encoding="utf-8", errors="replace") if fp.exists() else ""
    system = (
        "You are the implementer. Make the requested change to ONE file using "
        "SEARCH/REPLACE blocks. Format each block EXACTLY as:\n"
        "<<<<<<< SEARCH\n<exact existing lines>\n=======\n<replacement lines>\n"
        ">>>>>>> REPLACE\n"
        "SEARCH text must match the current file exactly. For a NEW file or "
        "full rewrite use one block with an EMPTY search section. Output ONLY "
        "blocks — no prose, no fences.")
    user = (f"FILE: {path}\n\nCURRENT CONTENTS:\n"
            f"{current if current else '(new file)'}\n\nINSTRUCTION:\n{instruction}")

    for attempt in range(2):
        out, _ = llm.chat_text(worker, system, user, max_tokens=8000)
        res = apply_sr_blocks(current, out.strip())
        if res is None:
            # No blocks: treat the whole output as the file body.
            body = out.strip()
            if body.startswith("```"):
                lines = body.split("\n")
                lines = lines[1:] if lines[0].startswith("```") else lines
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                body = "\n".join(lines)
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(body + ("" if body.endswith("\n") else "\n"), encoding="utf-8")
            TOUCHED.add(str(path))
            return f"implementer rewrote {path} ({len(body)} chars)"
        new, applied, total = res
        if applied == total:
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(new, encoding="utf-8")
            TOUCHED.add(str(path))
            return f"implementer edited {path} ({applied}/{total} blocks applied)"
        # Partial apply — tell the implementer which blocks missed and retry.
        user = (f"FILE: {path}\n\nCURRENT CONTENTS:\n{current}\n\n"
                f"INSTRUCTION:\n{instruction}\n\nYour previous SEARCH/REPLACE "
                f"blocks only matched {applied}/{total}. Re-read the current "
                "contents above and emit corrected blocks whose SEARCH text "
                "matches EXACTLY.")
    # Last resort: apply what did match rather than dropping everything.
    new, applied, total = res
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(new, encoding="utf-8")
    TOUCHED.add(str(path))
    return (f"implementer edited {path} but only {applied}/{total} blocks "
            "applied — VERIFY this file with read_file and fix the rest yourself")


# --- registry ----------------------------------------------------------------

def _schema(props, required):
    return {"type": "object", "properties": props, "required": required}


READ_TOOLS = [
    {"name": "read_file",
     "description": "Read a file from the workspace (line-numbered). Use "
                    "start_line/end_line for big files.",
     "input_schema": _schema({
         "path": {"type": "string", "description": "relative path"},
         "start_line": {"type": "integer"}, "end_line": {"type": "integer"},
     }, ["path"]),
     "fn": t_read_file},
    {"name": "list_files",
     "description": "List workspace files (relative paths with sizes). "
                    "Optional glob pattern, e.g. '*.py' or 'src/*'.",
     "input_schema": _schema({"pattern": {"type": "string"}}, []),
     "fn": t_list_files},
    {"name": "grep",
     "description": "Regex-search all workspace files; returns file:line: text "
                    "matches. Optional glob to filter files.",
     "input_schema": _schema({
         "pattern": {"type": "string", "description": "Python regex"},
         "glob": {"type": "string"},
     }, ["pattern"]),
     "fn": t_grep},
    {"name": "check_python",
     "description": "Syntax-check Python files without executing them. Empty "
                    "paths = every file you have touched this run.",
     "input_schema": _schema({
         "paths": {"type": "string", "description": "comma-separated .py paths (optional)"},
     }, []),
     "fn": t_check_python},
    {"name": "web_fetch",
     "description": "Fetch a URL (http/https) and return its readable text "
                    "(HTML is reduced to text). Use for docs, API references, "
                    "error pages, or a link the user pasted.",
     "input_schema": _schema({
         "url": {"type": "string", "description": "full http/https URL"},
         "max_chars": {"type": "integer", "description": "cap on returned chars (optional)"},
     }, ["url"]),
     "fn": t_web_fetch},
]

WRITE_TOOLS = [
    {"name": "write_file",
     "description": "Create or fully overwrite one file with the given content.",
     "input_schema": _schema({
         "path": {"type": "string"}, "content": {"type": "string"},
     }, ["path", "content"]),
     "fn": t_write_file},
    {"name": "str_replace",
     "description": "Replace an exact text snippet in a file. `old` must "
                    "appear verbatim (read the file first). Preferred over "
                    "write_file for modifying existing files.",
     "input_schema": _schema({
         "path": {"type": "string"}, "old": {"type": "string"},
         "new": {"type": "string"}, "replace_all": {"type": "boolean"},
     }, ["path", "old", "new"]),
     "fn": t_str_replace},
    {"name": "delete_file",
     "description": "Delete one file from the workspace.",
     "input_schema": _schema({"path": {"type": "string"}}, ["path"]),
     "fn": t_delete_file},
    {"name": "run_tests",
     "description": "Discover and run Python unittests in the workspace "
                    "(in-process; pure-Python only). Returns pass/fail + output.",
     "input_schema": _schema({
         "pattern": {"type": "string", "description": "filename pattern, default test*.py"},
     }, []),
     "fn": t_run_tests},
]

DELEGATE_TOOL = {
    "name": "delegate_edit",
    "description": "Delegate one file's edit to the cheap implementer model. "
                   "Give a precise, self-contained instruction. Use for "
                   "mechanical or boilerplate edits; do subtle edits yourself "
                   "with str_replace.",
    "input_schema": _schema({
        "path": {"type": "string"},
        "instruction": {"type": "string"},
    }, ["path", "instruction"]),
    "fn": t_delegate_edit,
}


def toolset(write=True, delegate=True):
    tools = list(READ_TOOLS)
    if write:
        tools += WRITE_TOOLS
        if delegate and (os.environ.get("WORKER_MODEL") or "").strip():
            tools.append(DELEGATE_TOOL)
    return tools


def execute(tools, name, args) -> str:
    for t in tools:
        if t["name"] == name:
            try:
                return str(t["fn"](**(args or {})))
            except TypeError as e:
                return f"(bad arguments for {name}: {e})"
            except Exception as e:
                return f"(tool {name} failed: {e})"
    return f"(unknown tool: {name})"
