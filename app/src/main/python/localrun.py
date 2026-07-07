"""
localrun.py — run a Python web app from the active workspace, in-process.

Supported entry points (first match wins), served on 127.0.0.1:<port>:
  1. app.py exposing a WSGI callable named `app` (Flask/Bottle/plain WSGI)
  2. a `wsgi.py` exposing `app`
  3. otherwise: a static file server rooted at the workspace

The server runs on a daemon background thread so the Kotlin WebView can load
http://127.0.0.1:<port>/. Only one server runs at a time.

Ports never hard-fail: start() always releases the previous server first, and if
the preferred port is somehow still held (a wedged shutdown, a stale server left
by the headless web-check, module state reset by an OTA reload), it falls back to
an OS-assigned free port instead of raising "address already in use". url()
always reports the port actually in use, and an atexit hook frees it on teardown.
"""

import os
import sys
import time
import atexit
import threading
import traceback
import importlib.util
from pathlib import Path
from wsgiref.simple_server import make_server, WSGIRequestHandler

_PREFERRED_PORT = 8765
_server = None
_thread = None
_bound_port = None          # the port the live server is actually bound to
# Serialize start/stop so overlapping calls (e.g. an auto web-check racing the
# Run button) can't both try to bind the port.
_LOCK = threading.RLock()


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    p = Path(ws)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _load_wsgi_app(root: Path):
    """Return a WSGI callable from app.py / wsgi.py, or None."""
    for name in ("app.py", "wsgi.py"):
        fp = root / name
        if fp.exists():
            sys.path.insert(0, str(root))
            spec = importlib.util.spec_from_file_location("user_app", str(fp))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            app = getattr(mod, "app", None)
            if app is not None:
                return app
    return None


# Development preview: forbid caching so every reload reflects the latest edit.
_NO_CACHE_HEADERS = [
    ("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"),
    ("Pragma", "no-cache"),
    ("Expires", "0"),
]


def _static_app(root: Path):
    """A tiny WSGI static-file server rooted at the workspace."""
    import mimetypes

    def app(environ, start_response):
        path = environ.get("PATH_INFO", "/").lstrip("/") or "index.html"
        fp = (root / path)
        if fp.is_dir():
            fp = fp / "index.html"
        if not fp.exists() or not fp.is_file():
            # Directory listing fallback.
            listing = "<h3>Files</h3><ul>" + "".join(
                f'<li><a href="/{p.relative_to(root)}">{p.relative_to(root)}</a></li>'
                for p in sorted(root.rglob("*")) if p.is_file() and ".git" not in p.parts
            ) + "</ul>"
            start_response("200 OK", [("Content-Type", "text/html")] + _NO_CACHE_HEADERS)
            return [listing.encode()]
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        start_response("200 OK", [("Content-Type", ctype)] + _NO_CACHE_HEADERS)
        return [fp.read_bytes()]

    return app


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def _bind(app, port):
    # WSGIServer/HTTPServer sets SO_REUSEADDR before binding (allow_reuse_address),
    # so a socket in TIME_WAIT won't block us. A LISTEN socket still held by a
    # zombie server will, which is what the ephemeral fallback in _make_server
    # exists to survive.
    return make_server("127.0.0.1", port, app, handler_class=_QuietHandler)


def _make_server(app):
    """Bind the server without ever hard-failing on a busy port.

    Try the preferred port (briefly retrying in case the previous socket is
    mid-release), then fall back to an OS-assigned free port (0) so a stuck or
    orphaned server on the preferred port can't stop a new run."""
    for _ in range(3):
        try:
            return _bind(app, _PREFERRED_PORT)
        except OSError:
            time.sleep(0.2)
    # Preferred port is still held — let the OS pick any free port instead.
    return _bind(app, 0)


def _quiet(fn):
    try:
        fn()
    except Exception:
        pass


def start() -> str:
    """(Re)start the server for the active workspace. Returns a status string."""
    global _server, _thread, _bound_port
    with _LOCK:
        try:
            stop()
            root = _workspace()
            app = _load_wsgi_app(root) or _static_app(root)
            _server = _make_server(app)
            _bound_port = _server.server_address[1]   # the port actually bound
            _thread = threading.Thread(target=_server.serve_forever, daemon=True)
            _thread.start()
            kind = "app" if (root / "app.py").exists() or (root / "wsgi.py").exists() else "static files"
            return f"http://127.0.0.1:{_bound_port}/  ({kind})"
        except Exception:
            return "Local run failed:\n" + traceback.format_exc()


def stop() -> str:
    """Release the running server and free its port. Cannot hang: shutdown() is
    given a bounded window (a wedged request handler can't block a new run), and
    the listening socket is closed regardless so the port is freed."""
    global _server, _thread, _bound_port
    with _LOCK:
        srv, th = _server, _thread
        _server = None
        _thread = None
        _bound_port = None
        if srv is not None:
            # shutdown() stops serve_forever; run it on a watchdog thread and only
            # wait briefly, so a slow in-flight request can't stall us.
            w = threading.Thread(target=lambda: _quiet(srv.shutdown), daemon=True)
            w.start()
            w.join(1.5)
            # server_close() releases the listening socket — the part that
            # actually frees the port for the next start().
            _quiet(srv.server_close)
        if th is not None and th.is_alive():
            th.join(1.0)
        return "stopped"


# Free the port on interpreter/process teardown too, so a clean exit never leaves
# it bound. (A hard kill / force-close is handled by the OS reclaiming the port.)
atexit.register(stop)


def url() -> str:
    port = _bound_port or _PREFERRED_PORT
    return f"http://127.0.0.1:{port}/"
