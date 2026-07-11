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
import sys
import json
import fnmatch
from pathlib import Path

import llm

# OTA resilience: this build's agent_loader only loads the modules named in its
# (bundled) _MODULES list. A module added to the manifest AFTER this APK shipped
# (e.g. workflows, best_practices) lands in the override dir but the old loader
# never registers it — so `import workflows` would fail with "no module named".
# Putting the override dir on sys.path lets plain imports resolve those files.
_ovr = os.environ.get("AGENT_OVERRIDE_DIR", "")
if _ovr and os.path.isdir(_ovr) and _ovr not in sys.path:
    sys.path.insert(0, _ovr)

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


def _atomic_write(fp: Path, content: str) -> None:
    """Write via a sibling temp file + rename so a kill mid-write can't leave the
    destination truncated (Android backgrounds/kills the process freely)."""
    fp.parent.mkdir(parents=True, exist_ok=True)
    tmp = fp.with_name(fp.name + ".tmp~")
    tmp.write_text(content, encoding="utf-8")
    os.replace(str(tmp), str(fp))


def _read_strict(fp: Path):
    """Read as UTF-8 without lossy replacement. Returns (text, None) or
    (None, error) so an edit refuses rather than round-tripping a binary/latin-1
    file through U+FFFD and corrupting bytes outside the edited span."""
    try:
        return fp.read_bytes().decode("utf-8"), None
    except UnicodeDecodeError:
        return None, (f"(refused — {fp.name} is not valid UTF-8 (binary or a "
                      "non-UTF-8 encoding). Editing it here would corrupt bytes "
                      "outside your change.)")


def _need_path(path, tool):
    """Return an error string if `path` is unusable, else None. Guards the
    common failure where a model omits/renames the path arg and it defaults to
    '' — which resolves to the workspace root (a directory)."""
    if not str(path).strip():
        return (f"({tool} needs a non-empty 'path' argument, e.g. "
                "\"index.html\" or \"src/app.py\" — relative to the workspace root)")
    try:
        fp = _resolve(path)
    except ValueError as e:
        return f"({e})"
    if fp.is_dir():
        return f"('{path}' is a directory, not a file)"
    return None


def _frugal_on() -> bool:
    """Frugal mode = spend less: tighter reads/grep and split-file nudges."""
    if os.environ.get("AGENT_FRUGAL", "0") == "1":
        return True
    try:
        return (_agent_dir() / "frugal").exists()
    except Exception:
        return False


def _read_cap() -> int:
    # Constant: smaller reads just make the model re-read (more steps, more
    # cost). File-per-feature keeps files small enough that 800 lines is plenty.
    return 800


def _grep_cap() -> int:
    return 200


def _split_threshold() -> int:
    # Frugal keeps the stricter split nudge (small files are a genuine win).
    return 250 if _frugal_on() else 450


def _looks_vendored(path: str, content: str) -> bool:
    """Heuristic: is this a pasted/minified library bundle that should be a CDN
    reference instead? .min.* files, or big script/style files with a huge
    single line (the hallmark of minification)."""
    p = str(path).lower()
    n = len(content)
    if p.endswith((".min.js", ".min.css")) and n > 10000:
        return True
    if p.endswith((".js", ".mjs", ".cjs", ".css")) and n > 30000:
        longest = max((len(l) for l in content.splitlines()), default=0)
        if longest > 2000:
            return True
    return False


_SKIP_DIRS = {".git", ".agent", "__pycache__", "node_modules"}


def _iter_files(root: Path):
    for p in sorted(root.rglob("*")):
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.name in ("meta.json", "transcript.jsonl"):
            continue
        if p.is_file():
            yield p


def _looks_binary(p: Path) -> bool:
    """A NUL byte in the first chunk is a reliable binary signal — skip these so
    grep doesn't fill the match budget with U+FFFD noise from PNGs/fonts/blobs."""
    try:
        with open(p, "rb") as f:
            return b"\x00" in f.read(2048)
    except Exception:
        return True


# --- inspection --------------------------------------------------------------

def t_read_file(path="", start_line=0, end_line=0, **_):
    if not str(path).strip():
        return "(read_file needs a non-empty 'path' argument, relative to the workspace root)"
    fp = _resolve(path)
    if fp.is_dir():
        return (f"('{path}' is a directory — use list_files to see its contents)")
    if not fp.exists() or not fp.is_file():
        return (f"(no such file: {path} — find it with list_files or grep, or "
                "create it with write_file)")
    try:
        text = fp.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"(unreadable: {e})"
    lines = text.splitlines()
    s = max(1, int(start_line or 1))
    e = int(end_line or 0) or len(lines)
    picked = lines[s - 1:e]
    cap = _read_cap()
    truncated = ""
    if len(picked) > cap:
        picked = picked[:cap]
        truncated = f"\n…({len(lines)} lines total; request a range for more)"
    # Clip very long individual lines (e.g. a minified bundle is one giant line
    # under the line cap) so a single read can't dump megabytes into context.
    line_clip = 2000
    out = []
    for i, l in enumerate(picked):
        if len(l) > line_clip:
            l = l[:line_clip] + f"…[+{len(l) - line_clip} chars clipped]"
        out.append(f"{i + s}\t{l}")
    return ("\n".join(out) + truncated) or "(empty file)"


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
    cap = _grep_cap()
    for p in _iter_files(root):
        rel = str(p.relative_to(root))
        if glob and not fnmatch.fnmatch(rel, glob):
            continue
        if _looks_binary(p):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                hits.append(f"{rel}:{n}: {line.strip()[:200]}")
                if len(hits) >= cap:
                    hits.append(f"…(truncated at {cap} matches)")
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
    # Cap below the 30000-char per-tool-result transport limit in llm.py, so a
    # larger request isn't silently re-truncated (and the full body isn't
    # decoded/stored only to be cut every step).
    limit = max(1000, min(limit, 28000))
    clipped = len(body) > limit
    return (f"URL: {url}\n\n" + body[:limit] +
            (f"\n\n…[truncated at {limit} chars of {len(body)}]" if clipped else ""))


# --- mutation ------------------------------------------------------------

def t_write_file(path="", content="", **_):
    err = _need_path(path, "write_file")
    if err:
        return err
    if _looks_vendored(path, content):
        return ("(refused — this looks like a vendored/minified library "
                f"(~{len(content) // 1000} KB, very long lines). Pasting library "
                "source bloats every step's context and will truncate. Load it "
                "from a pinned CDN instead: add a "
                '<script src="https://cdn.jsdelivr.net/npm/PACKAGE@VERSION/..."></script> '
                "tag (or an ESM import map) to your HTML and use it at runtime — "
                "the library then never enters the workspace.)")
    fp = _resolve(path)
    _atomic_write(fp, content)
    TOUCHED.add(str(path))
    nlines = content.count("\n") + 1
    warn = ""
    if nlines > _split_threshold():
        # Reinforce the file-per-feature convention at write time: a big file is
        # expensive to re-read every step and easy to truncate.
        warn = (f" — NOTE: {nlines} lines. Keep a context-friendly 'file per "
                "feature' layout: split distinct features into their own files "
                "and wire them from a small entry file, so each read/edit stays "
                "small and cheap.")
    return f"wrote {path} ({len(content)} chars){warn}"


def t_str_replace(path="", old="", new="", replace_all=False, **_):
    err = _need_path(path, "str_replace")
    if err:
        return err
    fp = _resolve(path)
    if not fp.exists():
        return f"(no such file: {path} — use write_file to create it)"
    text, rerr = _read_strict(fp)
    if rerr:
        return rerr
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
    _atomic_write(fp, text)
    TOUCHED.add(str(path))
    return f"replaced {count if replace_all else 1} occurrence(s) in {path}"


def t_delete_file(path="", **_):
    err = _need_path(path, "delete_file")
    if err:
        return err
    fp = _resolve(path)
    if not fp.exists():
        return f"(no such file: {path} — nothing to delete; check the path with list_files)"
    fp.unlink()
    TOUCHED.add(str(path))
    return f"deleted {path} (irreversible — recover from git if needed)"


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


def _strip_js_noncode(src: str) -> str:
    """Blank out comments, strings, template literals, and regex so bracket
    counting sees only code. Best-effort (no real JS parser on device)."""
    out = []
    i, n = 0, len(src)
    prev = ""  # last significant code char, for the regex-vs-division heuristic
    _re_pre = set("(,=:[!&|?{};+-*%<>~^")
    while i < n:
        c = src[i]
        two = src[i:i + 2]
        if two == "//":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if two == "/*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"`":
            q = c
            i += 1
            while i < n and src[i] != q:
                i += 2 if src[i] == "\\" else 1
            i += 1
            out.append("0")
            prev = "0"
            continue
        if c == "/" and (prev == "" or prev in _re_pre):
            j, inclass, ok = i + 1, False, False
            while j < n:
                cj = src[j]
                if cj == "\\":
                    j += 2
                    continue
                if cj == "\n":
                    break
                if cj == "[":
                    inclass = True
                elif cj == "]":
                    inclass = False
                elif cj == "/" and not inclass:
                    ok = True
                    break
                j += 1
            if ok:
                i = j + 1
                out.append("0")
                prev = "0"
                continue
        if not c.isspace():
            prev = c
        out.append(c)
        i += 1
    return "".join(out)


def _js_bracket_report(rel: str, src: str) -> str:
    """Return a note if () {} [] don't balance in code regions, else ''."""
    code = _strip_js_noncode(src)
    match = {")": "(", "}": "{", "]": "["}
    stack = []
    for ch in code:
        if ch in "([{":
            stack.append(ch)
        elif ch in ")]}":
            if not stack or stack[-1] != match[ch]:
                return (f"{rel}: unbalanced '{ch}' — bracket mismatch "
                        "(possible truncation or typo)")
            stack.pop()
    if stack:
        return (f"{rel}: {len(stack)} unclosed '{stack[-1]}' "
                "(file may be truncated)")
    return ""


def check_web_files(paths=None):
    """Static checks for touched web files. Returns (hard, soft):
      hard — deterministic breakage (a script/link/import points at a local file
             that does not exist). Safe to auto-fail a run on.
      soft — heuristic findings (unbalanced brackets) shown to the agent but not
             auto-failed, since the headless preview is the real runtime check.
    """
    root = _workspace()
    if paths is None:
        paths = [p for p in TOUCHED
                 if p.lower().endswith((".html", ".htm", ".js", ".mjs"))]
    try:
        import projectmap as pm
    except Exception:
        return "", ""
    fileset = set()
    for p in root.rglob("*"):
        if ".git" in p.parts or ".agent" in p.parts:
            continue
        if p.is_file():
            fileset.add(str(p.relative_to(root)).replace("\\", "/"))
    hard, soft = [], []
    for rel in paths:
        fp = root / rel
        if not fp.exists():
            continue
        low = rel.lower()
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        if low.endswith((".html", ".htm")):
            for m in pm._HTML_REF.finditer(text):
                ref = m.group(1)
                if pm._is_external(ref) or ref.startswith(("#", "mailto:", "tel:")):
                    continue
                if not pm._resolve_path(root, rel, ref, fileset):
                    hard.append(f"{rel}: references missing local file '{ref}'")
        if low.endswith((".js", ".mjs")):
            for m in pm._JS_IMPORT.finditer(text):
                ref = m.group(1)
                if pm._is_external(ref) or not ref.startswith((".", "/")):
                    continue  # external/bare package specifier
                if not pm._resolve_path(root, rel, ref, fileset):
                    hard.append(f"{rel}: imports missing local file '{ref}'")
            note = _js_bracket_report(rel, text)
            if note:
                soft.append(note)
    return "\n".join(hard), "\n".join(soft)


def t_check_web(paths="", **_):
    lst = [p.strip() for p in str(paths).split(",") if p.strip()] or None
    hard, soft = check_web_files(lst)
    out = []
    if hard:
        out.append("MISSING REFERENCES:\n" + hard)
    if soft:
        out.append("POSSIBLE ISSUES (confirm in the preview):\n" + soft)
    return "\n\n".join(out) or "OK — no obvious web issues"


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
    # Set effort for the implementer model before the LLM call.
    os.environ["AGENT_EFFORT"] = os.environ.get("AGENT_IMPL_EFFORT",
        os.environ.get("AGENT_EFFORT", "off"))
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
    # Inject the best practices relevant to THIS step — tag-matched on the
    # instruction — so the implementer building this file follows them (e.g. a
    # "floating joystick" instruction pulls the movement rule).
    try:
        import best_practices
        bp = best_practices.render(instruction)
    except Exception:
        bp = ""
    if bp:
        system += "\n\nApply these best practices where they fit this file:\n" + bp
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


# --- multi-agent workflows (fan out to several agents, then judge) ----------

def t_brainstorm(topic="", count=4, criteria="", **_):
    """Run several idea agents in parallel, score them, return ranked ideas."""
    try:
        import workflows
    except Exception:
        return ("(multi-agent workflows aren't loaded — tap Update agent to fetch "
                "the latest modules, then try again)")
    if not str(topic).strip():
        return "(brainstorm needs a topic)"
    res = workflows.ideate(str(topic), n=count, criteria=str(criteria))
    cands = res["candidates"]
    by_n = {r["n"]: r for r in res["ranking"]}
    order = [r["n"] for r in res["ranking"]] or list(range(1, len(cands) + 1))
    for i in range(1, len(cands) + 1):  # append any the judge missed
        if i not in order:
            order.append(i)
    out = [f"Brainstormed {len(cands)} ideas for “{res['topic']}” (best first):"]
    for n in order:
        if not (1 <= n <= len(cands)):
            continue
        c = cands[n - 1]
        r = by_n.get(n)
        head = f"\n[{n}]"
        if c["angle"]:
            head += f" ({c['angle']})"
        if r:
            head += f" — {r['score']:.0f}/10: {r['why']}"
        out.append(head + "\n" + c["text"])
    out.append(f"\nTop pick: [{res['best']}]. Present these to the user and ask "
               "which to build (or whether to combine ideas).")
    return "\n".join(out)


def t_delegate_parallel(files=None, **_):
    """Build several files at once — one implementer per file, in parallel."""
    try:
        import workflows
    except Exception:
        return ("(multi-agent workflows aren't loaded — tap Update agent to fetch "
                "the latest modules, then try again)")
    items = files
    if isinstance(items, dict):
        items = [items]
    res = workflows.parallel_edits(items or [])
    if not res:
        return "(no files given — pass files=[{path, instruction}, ...])"
    return "Parallel build (" + str(len(res)) + " files):\n" + \
        "\n".join(f"- {r['result']}" for r in res)


# --- git tools (wrap git_ops so the agent can orchestrate git itself) --------
# git_ops is imported lazily inside each tool so the OTA loader's override copy
# is picked up (agent_tools loads before git_ops).

def t_git_status(**_):
    import git_ops
    return git_ops.status_summary()


def t_git_branch(name="", **_):
    import git_ops
    return git_ops.start_branch(name)


def t_git_commit(message="", **_):
    import git_ops
    return git_ops.commit(message)


def t_git_push(**_):
    import git_ops
    return git_ops.push()


def t_git_open_pr(title="", body="", **_):
    import git_ops
    return git_ops.create_pr(title, body)


def t_git_pr_status(**_):
    import git_ops
    return git_ops.pr_status()


def t_git_merge_pr(method="merge", **_):
    import git_ops
    return git_ops.merge_pr(method)


def t_git_pull(**_):
    import git_ops
    return git_ops.pull()


def t_git_checkout(name="", **_):
    import git_ops
    return git_ops.checkout(name)


def t_git_delete_branch(name="", remote=False, **_):
    import git_ops
    return git_ops.delete_branch(name, bool(remote))


def t_git_list_branches(**_):
    import git_ops
    return git_ops.list_branches()


def t_git_prune_branches(dry_run=False, **_):
    import git_ops
    return git_ops.prune_branches(bool(dry_run))


def t_git_update_from_base(**_):
    import git_ops
    return git_ops.update_from_base()


def t_git_force_push(**_):
    import git_ops
    return git_ops.push_force()


def t_git_start(name="", **_):
    import git_ops
    return git_ops.start_fresh(name)


def t_git_ship(title="", body="", **_):
    import git_ops
    return git_ops.ship(title, body)


# --- todo list (TodoWrite-style live checklist) ------------------------------

def _agent_dir() -> Path:
    d = _workspace() / ".agent"
    d.mkdir(parents=True, exist_ok=True)
    return d


_TODO_STATES = ("pending", "in_progress", "completed")


def read_todos() -> list:
    fp = _agent_dir() / "todos.json"
    if fp.exists():
        try:
            return json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _newly_completed(prev, clean) -> list:
    """Steps that flipped to completed in this update (matched by content)."""
    was = {t.get("content"): t.get("status") for t in prev}
    return [t["content"] for t in clean
            if t["status"] == "completed" and was.get(t["content"]) != "completed"]


# --- independent code review (a second model reviews the diff) --------------

def _head_content(root: Path, rel: str):
    """The file's content at HEAD (before this run's edits), or None if it's a
    new file / no repo. Used to diff the run's changes for review."""
    try:
        from dulwich.repo import Repo
        from dulwich.object_store import tree_lookup_path
        r = Repo(str(root))
        _mode, sha = tree_lookup_path(r.get_object, r[r.head()].tree, rel.encode())
        return r[sha].data.decode("utf-8", "replace")
    except Exception:
        return None


def build_review_diff(paths=None, max_files=15, cap=8000) -> str:
    """Unified diff (working tree vs HEAD) of the files this run touched, so a
    reviewer sees exactly what changed rather than whole files."""
    import difflib
    root = _workspace()
    rels = sorted(paths if paths is not None else TOUCHED)[:max_files]
    chunks = []
    for rel in rels:
        fp = root / rel
        new = None
        if fp.exists() and fp.is_file():
            try:
                new = fp.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
        old = _head_content(root, rel)
        if old == new:
            continue
        diff = difflib.unified_diff(
            (old or "").splitlines(keepends=True),
            (new or "").splitlines(keepends=True),
            fromfile=(f"a/{rel}" if old is not None else "/dev/null"),
            tofile=(f"b/{rel}" if new is not None else "/dev/null"))
        chunks.append("".join(diff)[:cap])
    return "\n".join(chunks)


_REVIEW_SYSTEM = (
    "You are a senior code reviewer. You are given the TASK the author was asked "
    "to do and a unified DIFF of their change. Review ONLY the change for REAL "
    "problems: correctness bugs, missed edge cases, broken/again-failing behavior, "
    "security issues, or a change that doesn't actually accomplish the task. "
    "Ignore style, naming, and nitpicks. Be concise.\n"
    "For each real issue: `file:line — problem` and its severity "
    "(blocker/major/minor).\n"
    "FIRST LINE of your reply MUST be exactly `VERDICT: BLOCK` if there is at "
    "least one blocker or major correctness/security issue that must be fixed "
    "before shipping, otherwise `VERDICT: PASS`. Then the findings (or 'LGTM')."
)


def review_changes(model: str, task: str):
    """Have `model` review this run's diff. Returns (block: bool, report: str).
    (False, "") when there's nothing to review."""
    diff = build_review_diff()
    if not diff.strip():
        return False, ""
    user = (f"TASK:\n{task[:2000]}\n\nDIFF:\n{diff[:24000]}")
    try:
        text, _reason = llm.chat_text(model, _REVIEW_SYSTEM, user, max_tokens=1500)
    except Exception:
        return False, ""   # never let review failure block a run
    block = text.lstrip().upper().startswith("VERDICT: BLOCK")
    return block, text.strip()


def _step_verify() -> str:
    """Fast, forward-reference-SAFE self-check for a just-completed step: does the
    code you just wrote actually parse / is it structurally complete?

    Deliberately NOT the missing-reference or full-test checks — mid-plan the
    entry file may point at a feature file you create in a later step, and tests
    may not pass until a later step lands, so those run at end of the run instead.
    This only flags what is broken regardless of build order (syntax errors,
    truncated writes, unbalanced brackets), so issues don't compound.
    """
    problems = []
    try:
        errs = check_python_files()
        if errs:
            problems.append("Python doesn't compile:\n" + errs)
    except Exception:
        pass
    try:
        _hard, soft = check_web_files()
        if soft:
            problems.append("HTML/JS looks malformed or truncated:\n" + soft)
    except Exception:
        pass
    if problems:
        return ("\n\n⚠️ You marked a step complete, but the code you just wrote is "
                "broken — fix it NOW before the next step:\n" + "\n\n".join(problems))
    return ""


def t_todo_write(todos=None, **_):
    """Replace the task checklist. `todos` is a list of {content, status} where
    status is pending | in_progress | completed. Overwrites the whole list."""
    if not isinstance(todos, list):
        return "(todos must be a list of {content, status})"
    prev = read_todos()
    clean = []
    for t in todos:
        if isinstance(t, str):
            t = {"content": t, "status": "pending"}
        if not isinstance(t, dict):
            continue
        content = str(t.get("content", "")).strip()
        if not content:
            continue
        status = str(t.get("status", "pending")).strip().lower()
        if status not in _TODO_STATES:
            status = "pending"
        clean.append({"content": content, "status": status})
    (_agent_dir() / "todos.json").write_text(json.dumps(clean), encoding="utf-8")
    # Push a live event so the UI checklist updates during the run.
    try:
        import agentloop
        agentloop._emit("todos", todos=clean)
    except Exception:
        pass
    done = sum(1 for t in clean if t["status"] == "completed")
    doing = next((t["content"] for t in clean if t["status"] == "in_progress"), "")
    tail = f"; now: {doing}" if doing else ""
    # When a step is newly completed, self-check the code right away so the agent
    # verifies each step instead of building the whole app and checking at the end.
    note = ""
    if os.environ.get("AGENT_STEP_VERIFY", "1") != "0" and _newly_completed(prev, clean):
        note = _step_verify()
    return f"todos updated ({done}/{len(clean)} done{tail})" + note


# --- persistent scratchpad (durable working memory across tasks) --------------

_SCRATCH_CAP = 4000   # chars — keep working memory tight; it rides context


def _scratch_file() -> Path:
    return _agent_dir() / "scratchpad.md"


def read_scratch() -> str:
    fp = _scratch_file()
    try:
        return fp.read_text(encoding="utf-8") if fp.exists() else ""
    except Exception:
        return ""


def t_note_write(text="", append=False, **_):
    """Save your persistent working notes (goal, key decisions, current state,
    gotchas). Carried into every future task's context, so you don't re-derive
    them. append=false replaces; append=true adds to the end."""
    text = str(text or "")
    if append:
        cur = read_scratch()
        text = cur + ("\n" if cur and not cur.endswith("\n") else "") + text
    if len(text) > _SCRATCH_CAP:
        text = text[-_SCRATCH_CAP:]   # keep the most recent notes
    try:
        _scratch_file().write_text(text, encoding="utf-8")
    except Exception as e:
        return f"(note_write failed: {e})"
    return f"working notes saved ({len(text)} chars)"


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
    {"name": "check_web",
     "description": "Static-check touched HTML/JS files: flags <script>/<link>/"
                    "import references to local files that don't exist, and "
                    "possible unbalanced brackets. Empty paths = every web file "
                    "you touched this run.",
     "input_schema": _schema({
         "paths": {"type": "string", "description": "comma-separated .html/.js paths (optional)"},
     }, []),
     "fn": t_check_web},
    {"name": "web_fetch",
     "description": "Fetch a URL (http/https) and return its readable text "
                    "(HTML is reduced to text). Use for docs, API references, "
                    "error pages, or a link the user pasted.",
     "input_schema": _schema({
         "url": {"type": "string", "description": "full http/https URL"},
         "max_chars": {"type": "integer", "description": "cap on returned chars (optional)"},
     }, ["url"]),
     "fn": t_web_fetch},
    {"name": "git_status",
     "description": "Show the current branch, remote, and uncommitted changes.",
     "input_schema": _schema({}, []),
     "fn": t_git_status},
    {"name": "brainstorm",
     "description": "Run several idea-generating agents IN PARALLEL on a topic, "
                    "then score and rank their ideas. Use when the user wants "
                    "multiple options/concepts to choose from — game mechanics, "
                    "art directions, names, level ideas, enemy designs. Returns "
                    "diverse ranked ideas; present them and ask which to build.",
     "input_schema": _schema({
         "topic": {"type": "string", "description": "what to brainstorm"},
         "count": {"type": "integer", "description": "how many ideas (default 4, max 8)"},
         "criteria": {"type": "string", "description": "what makes a good idea here (optional)"},
     }, ["topic"]),
     "fn": t_brainstorm},
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
    {"name": "todo_write",
     "description": "Maintain a task checklist the user watches live. Call it "
                    "at the start of a multi-step task with all steps, then "
                    "again after each step to update statuses. Replaces the "
                    "whole list each call. Keep exactly one item in_progress. "
                    "Marking a step completed auto-runs a quick self-check on the "
                    "code you touched; if it reports breakage, fix it before the "
                    "next step.",
     "input_schema": _schema({
         "todos": {"type": "array", "items": {
             "type": "object",
             "properties": {
                 "content": {"type": "string"},
                 "status": {"type": "string", "enum": list(_TODO_STATES)},
             },
             "required": ["content", "status"],
         }},
     }, ["todos"]),
     "fn": t_todo_write},
    {"name": "note_write",
     "description": "Save your PERSISTENT working notes — the durable goal, key "
                    "decisions, current state, and gotchas for what you're "
                    "building. These are carried into every future task's "
                    "context, so record things here instead of re-explaining or "
                    "re-deriving them. append=false replaces the notes; "
                    "append=true adds to the end. Keep it concise.",
     "input_schema": _schema({
         "text": {"type": "string"}, "append": {"type": "boolean"},
     }, ["text"]),
     "fn": t_note_write},
    {"name": "git_branch",
     "description": "Create and switch to a work branch (safe: files unchanged). "
                    "Blank name = agent/<workspace>. Do this before editing when "
                    "you intend to open a PR.",
     "input_schema": _schema({"name": {"type": "string"}}, []),
     "fn": t_git_branch},
    {"name": "git_commit",
     "description": "Stage all workspace changes and commit with a message.",
     "input_schema": _schema({"message": {"type": "string"}}, ["message"]),
     "fn": t_git_commit},
    {"name": "git_push",
     "description": "Push the current branch to the GitHub remote. Only when the "
                    "user asked to publish/push.",
     "input_schema": _schema({}, []),
     "fn": t_git_push},
    {"name": "git_open_pr",
     "description": "Open a pull request from the current branch to the repo's "
                    "default branch (pushes first). Only when the user asked for "
                    "a PR.",
     "input_schema": _schema({
         "title": {"type": "string"}, "body": {"type": "string"},
     }, []),
     "fn": t_git_open_pr},
    {"name": "git_pr_status",
     "description": "Report the open PR for the current branch and its CI verdict "
                    "(passing / failing / running). Check this before merging.",
     "input_schema": _schema({}, []),
     "fn": t_git_pr_status},
    {"name": "git_merge_pr",
     "description": "Merge the open PR for the current branch into its base "
                    "branch. Only when the user asked to merge. Prefer checking "
                    "git_pr_status first — GitHub blocks the merge if CI is "
                    "failing, a review is required, or there's a conflict, and "
                    "this returns that reason. method: merge | squash | rebase.",
     "input_schema": _schema({
         "method": {"type": "string", "enum": ["merge", "squash", "rebase"]},
     }, []),
     "fn": t_git_merge_pr},
    {"name": "git_pull",
     "description": "Pull the current branch from origin (falls back to the "
                    "default branch). Use to sync after a merge.",
     "input_schema": _schema({}, []),
     "fn": t_git_pull},
    {"name": "git_checkout",
     "description": "Switch to an existing local branch (e.g. back to main after "
                    "merging). Refuses if there are uncommitted changes.",
     "input_schema": _schema({"name": {"type": "string"}}, ["name"]),
     "fn": t_git_checkout},
    {"name": "git_delete_branch",
     "description": "Delete a branch after its PR is merged (cleanup). Deletes "
                    "the local branch; set remote=true to also delete it on "
                    "GitHub. Auto-switches off the branch first if it's checked "
                    "out; never deletes the default branch.",
     "input_schema": _schema({
         "name": {"type": "string"}, "remote": {"type": "boolean"},
     }, ["name"]),
     "fn": t_git_delete_branch},
    {"name": "git_list_branches",
     "description": "List all branches, flagging which are safe to delete (their "
                    "PR merged, or already in the default branch) vs. which still "
                    "have unmerged work. Use to answer 'what branches do I have?' "
                    "or before pruning.",
     "input_schema": _schema({}, []),
     "fn": t_git_list_branches},
    {"name": "git_prune_branches",
     "description": "Clean up ALL stale branches at once: delete every merged "
                    "non-default branch (local + remote). Never deletes the "
                    "default branch or branches with unmerged commits. Set "
                    "dry_run=true to preview what would be deleted first.",
     "input_schema": _schema({"dry_run": {"type": "boolean"}}, []),
     "fn": t_git_prune_branches},
    {"name": "git_update_from_base",
     "description": "Bring the current branch up to date with the default branch "
                    "when a PR won't merge because it's behind/conflicting. Merges "
                    "the latest default in; on a clean merge, git_push then "
                    "git_merge_pr; on conflicts it lists the files to fix (resolve "
                    "the <<<<<<< markers, then git_commit + git_push). If it can't "
                    "merge on-device, rebuild the branch from the default branch.",
     "input_schema": _schema({}, []),
     "fn": t_git_update_from_base},
    {"name": "git_force_push",
     "description": "Force-push the current branch (overwrites the remote branch "
                    "with local history). Use after rebuilding/rewriting a branch "
                    "to fix conflicts. Refuses on the default branch.",
     "input_schema": _schema({}, []),
     "fn": t_git_force_push},
    {"name": "git_start",
     "description": "PREFERRED way to begin a change: start a fresh feature "
                    "branch from an up-to-date default branch (switches to "
                    "default, pulls latest, then branches). Avoids conflicts. "
                    "Refuses if you have uncommitted changes.",
     "input_schema": _schema({"name": {"type": "string"}}, ["name"]),
     "fn": t_git_start},
    {"name": "git_ship",
     "description": "Finish a change in one step: commit pending work, push, and "
                    "open a PR. Use after making + verifying your edits on a "
                    "feature branch. Then git_pr_status and git_merge_pr.",
     "input_schema": _schema({
         "title": {"type": "string"}, "body": {"type": "string"},
     }, []),
     "fn": t_git_ship},
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

DELEGATE_PARALLEL_TOOL = {
    "name": "delegate_parallel",
    "description": "Build MULTIPLE independent files at once — one implementer per "
                   "file, running in parallel (much faster than one at a time). "
                   "Each item is {path, instruction} with a precise, "
                   "self-contained spec. Use for several new files (e.g. "
                   "player.js, enemies.js, ui.js); verify each afterward.",
    "input_schema": _schema({
        "files": {"type": "array", "items": {
            "type": "object",
            "properties": {"path": {"type": "string"},
                           "instruction": {"type": "string"}},
            "required": ["path", "instruction"]}},
    }, ["files"]),
    "fn": t_delegate_parallel,
}


def toolset(write=True, delegate=True):
    tools = list(READ_TOOLS)
    if write:
        tools += WRITE_TOOLS
        if delegate and (os.environ.get("WORKER_MODEL") or "").strip():
            tools.append(DELEGATE_TOOL)
            tools.append(DELEGATE_PARALLEL_TOOL)
    return tools


# Common aliases models reach for. Keyed by our canonical param name; a tool
# only ever pulls an alias into a param it actually declares, so there's no
# cross-tool confusion (e.g. "text" fills content for write_file, message for
# git_commit — whichever that tool has).
_SYNONYMS = {
    "path": ("file", "filename", "file_name", "filepath", "file_path",
             "filePath", "target", "name", "pathname"),
    "content": ("text", "data", "body", "contents", "file_content",
                "fileContent", "value", "code", "source"),
    "old": ("old_str", "old_string", "oldStr", "search", "find", "from",
            "original", "target_text"),
    "new": ("new_str", "new_string", "newStr", "replace", "replacement",
            "to", "with"),
    "url": ("link", "href", "uri", "address"),
    "pattern": ("query", "regex", "q", "search", "expr"),
    "message": ("msg", "text", "commit_message", "commitMessage", "m"),
    "instruction": ("instructions", "task", "prompt", "detail"),
    "todos": ("items", "tasks", "list", "todo", "todo_list"),
    "text": ("notes", "note", "memo", "working_notes", "scratchpad"),
    "title": ("subject", "name", "heading"),
    "method": ("merge_method", "mergeMethod", "strategy", "mode"),
    "name": ("branch", "branch_name", "branchName", "ref"),
    "remote": ("delete_remote", "remote_too", "remoteToo", "push_delete",
               "also_remote", "on_remote"),
}


def _normalize_args(tool, args: dict) -> dict:
    """Fill any of the tool's declared params that arrived empty from a known
    alias the model used instead — so the model's intent works even when it
    names an argument differently than our schema."""
    props = (tool.get("input_schema") or {}).get("properties") or {}
    out = dict(args)
    for canonical in props:
        cur = out.get(canonical)
        if cur is not None and str(cur).strip() != "":
            continue
        for alias in _SYNONYMS.get(canonical, ()):
            if alias == canonical:
                continue
            val = args.get(alias)
            if val is not None and str(val).strip() != "":
                out[canonical] = val
                break
    return out


def execute(tools, name, args) -> str:
    for t in tools:
        if t["name"] == name:
            try:
                return str(t["fn"](**_normalize_args(t, args or {})))
            except TypeError as e:
                return f"(bad arguments for {name}: {e})"
            except Exception as e:
                return f"(tool {name} failed: {e})"
    return f"(unknown tool: {name})"
