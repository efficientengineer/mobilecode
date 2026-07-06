"""
best_practices.py — a curated, tag-matched playbook the agent follows by default.

The problem it solves: left alone the model makes plausible-but-bad mobile
choices — fixed d-pad buttons instead of a floating joystick, text too small to
read, a canvas that ignores the notch, audio that autoplays and gets blocked.

Rather than dump the whole playbook into every payload, each practice carries
trigger TAGS (word stems). Only practices whose tags appear in the request are
injected — mention "moving" or "rotating" and you get the movement/rotation
rules; mention "text" or "keyboard" and you get the typography/input rules. A
generic request on a mobile project falls back to a small CORE set so essentials
are never missed; a non-mobile project gets nothing.

The block is computed once per run from the (fixed) request, so it stays inside
the cached context prefix — no per-step cache thrash.

Two layers: BUILT-IN practices here (OTA-updatable) and the USER's own global
best_practices.md that persists across every project and OVERRIDES the built-ins.
"""

import os
import re
from pathlib import Path

# Each practice: scope ("game" = game projects only, "web" = any mobile web
# project incl. games), core (part of the fallback set), tags (word STEMS matched
# as a prefix against request words, so "mov" hits move/moving/movement), text.
PRACTICES = [
    # --- controls / input (game) ---
    {"scope": "game", "core": True,
     "tags": ["joystick", "mov", "control", "input", "walk", "run", "steer",
              "dpad", "wasd", "arrow", "thumb", "drag", "analog", "stick",
              "navigat", "strafe", "left", "right", "up", "down"],
     "text": "Movement: use a FLOATING JOYSTICK, not fixed d-pad/arrow buttons — "
             "it appears where the left thumb first touches, follows within a max "
             "radius, and resets on release. Action buttons go on the right, in "
             "thumb reach."},
    {"scope": "game", "core": False,
     "tags": ["rotat", "turn", "spin", "aim", "look", "orient", "angle",
              "direction", "facing", "twist", "steer"],
     "text": "Rotation/aim: drive it from a drag delta or a right-thumb "
             "twin-stick (map the angle to the drag vector), never tiny +/- or "
             "left/right rotate buttons."},
    {"scope": "game", "core": False,
     "tags": ["touch", "multitouch", "pointer", "gesture", "tap", "fire",
              "shoot", "button", "simultaneous", "combo", "hold"],
     "text": "Multi-touch: track pointers by pointerId (Pointer Events) so moving "
             "with one thumb and firing with the other at the same time both "
             "register. Never assume a single active touch."},
    # --- game loop (game) ---
    {"scope": "game", "core": True,
     "tags": ["loop", "updat", "speed", "fast", "slow", "fps", "framerate",
              "frame", "tick", "animat", "physics", "gravity", "jump", "mov",
              "delta", "timestep", "velocity"],
     "text": "Loop: advance by delta time from requestAnimationFrame (or a fixed "
             "timestep with an accumulator) so speed is identical on 60Hz and "
             "120Hz screens. Never move a constant amount per frame."},
    {"scope": "game", "core": False,
     "tags": ["pause", "background", "hidden", "blur", "resume", "focus", "tab",
              "minimiz", "inactiv", "away"],
     "text": "Auto-pause and mute when not visible: on visibilitychange/blur stop "
             "the loop and audio, resume on return — backgrounding must not keep "
             "running or blast sound."},
    {"scope": "game", "core": False,
     "tags": ["audio", "sound", "music", "sfx", "autoplay", "mute", "volume",
              "noise", "play"],
     "text": "Unlock audio on the first tap (mobile blocks autoplay): resume the "
             "AudioContext from a user gesture, behind a tap-to-start overlay."},
    {"scope": "game", "core": False,
     "tags": ["haptic", "vibrat", "feedback", "rumble", "buzz"],
     "text": "Haptics: navigator.vibrate on impactful events (hit, pickup, death) "
             "where supported — short, sparing pulses make mobile feel responsive."},
    {"scope": "game", "core": True,
     "tags": ["canvas", "render", "resiz", "resolution", "blurry", "crisp",
              "pixel", "dpr", "retina", "draw", "scale", "sharp"],
     "text": "Canvas fills the viewport, is redrawn on resize, and scales its "
             "backing store by devicePixelRatio so it stays crisp on high-DPI "
             "phones."},
    # --- UI & text (any mobile web project) ---
    {"scope": "web", "core": True,
     "tags": ["text", "font", "size", "label", "read", "legib", "typograph",
              "caption", "title", "head", "word", "copy", "paragraph"],
     "text": "Body text >= 16px (also stops iOS zooming when an input is focused); "
             "size with clamp()/rem and respect the OS font-size setting — never "
             "tiny fixed px."},
    {"scope": "web", "core": False,
     "tags": ["contrast", "color", "colour", "dark", "light", "background",
              "overlay", "visib", "theme", "scrim", "legib"],
     "text": "High contrast (WCAG AA, >= 4.5:1); don't rely on color alone; put a "
             "scrim behind text over images/video so it stays legible."},
    {"scope": "web", "core": True,
     "tags": ["button", "tap", "target", "touch", "thumb", "reach", "hit",
              "click", "press", "icon", "menu", "link", "control", "toolbar"],
     "text": "Touch targets >= 48px with >= 8px gaps; put primary actions in the "
             "bottom thumb zone, not top corners (hard to reach one-handed)."},
    {"scope": "web", "core": True,
     "tags": ["safe", "notch", "inset", "status", "home", "edge", "cutout",
              "fullscreen", "bezel", "island", "corner"],
     "text": "Respect safe areas: viewport-fit=cover + env(safe-area-inset-*) "
             "padding so a notch, rounded corner, or home indicator never covers "
             "UI."},
    {"scope": "web", "core": False,
     "tags": ["hover", "feedback", "press", "active", "tap", "tooltip",
              "highlight", "state", "ripple", "touch"],
     "text": "Give instant feedback on every tap (pressed state, haptic where it "
             "matters); never rely on hover — touch has none, so no hover-only "
             "menus or tooltips."},
    {"scope": "web", "core": False,
     "tags": ["height", "viewport", "fullscreen", "scroll", "resiz", "vh",
              "address", "bar", "overflow", "sticky", "fixed"],
     "text": "Use dynamic viewport units (100dvh/svh), not 100vh — the mobile URL "
             "bar shows/hides and 100vh gets clipped or leaves gaps."},
    {"scope": "web", "core": False,
     "tags": ["keyboard", "input", "form", "field", "type", "email", "number",
              "focus", "entry", "textbox", "search", "login", "signup"],
     "text": "Handle the on-screen keyboard: scroll the focused field into view, "
             "and set inputmode/enterkeyhint/type (email/number/tel) so the right "
             "keyboard appears."},
    {"scope": "web", "core": False,
     "tags": ["layout", "grid", "column", "responsiv", "screen", "page",
              "arrang", "spacing", "dense", "design", "position", "align", "flex"],
     "text": "Design single-column with generous spacing and large hit areas; "
             "don't shrink a dense desktop layout onto a phone."},
    {"scope": "web", "core": False,
     "tags": ["scroll", "zoom", "gesture", "select", "drag", "refresh", "swipe",
              "pan", "pinch"],
     "text": "On interactive surfaces disable stray gestures (touch-action, "
             "user-select:none, block double-tap zoom / pull-to-refresh) — but "
             "keep normal content scrollable."},
    {"scope": "web", "core": False,
     "tags": ["load", "fetch", "async", "network", "api", "request", "spinner",
              "error", "empty", "offline", "wait", "save", "submit", "sync"],
     "text": "Show loading / empty / error states for every async action; mobile "
             "networks are slow and flaky, so never leave a dead-looking screen."},
    # --- performance & constraints (any mobile web project) ---
    {"scope": "web", "core": False,
     "tags": ["performanc", "perf", "batter", "fps", "frame", "lag", "slow",
              "jank", "stutter", "optim", "smooth", "heat", "drain", "efficien"],
     "text": "Do less work: pause rendering/logic when hidden or offscreen and "
             "cap the frame rate to what's needed — a busy loop drains the battery "
             "and heats the phone."},
    {"scope": "web", "core": False,
     "tags": ["performanc", "perf", "slow", "lag", "jank", "image", "asset",
              "shadow", "blur", "filter", "optim", "heavy", "big", "compress"],
     "text": "Stay light: avoid big blurs/shadows/filters and oversized images "
             "(serve sized & compressed), avoid layout thrash, and reuse objects "
             "to avoid GC stutter."},
    {"scope": "web", "core": False,
     "tags": ["memory", "leak", "dispose", "cleanup", "unload", "crash", "ram",
              "asset", "destroy", "remov", "teardown"],
     "text": "Free assets and remove listeners on scene/route change — mobile RAM "
             "is tight and leaks eventually crash the tab."},
    {"scope": "web", "core": False,
     "tags": ["network", "offline", "load", "fetch", "api", "connection",
              "cache", "request", "download", "data", "sync"],
     "text": "Assume a slow, flaky connection: keep the initial payload small, "
             "lazy-load, cache, and degrade gracefully offline."},
    {"scope": "web", "core": False,
     "tags": ["test", "device", "phone", "real", "orient", "landscape",
              "portrait", "rotat"],
     "text": "Verify on a real mid-range phone in both orientations with a notch "
             "— the desktop preview misrepresents size, touch, and speed."},
    # --- architecture & decoupling (event-driven, ScriptableObject-style) ---
    {"scope": "web", "core": True,
     "tags": ["event", "architect", "decoupl", "coupling", "structur", "modular",
              "depend", "communicat", "signal", "message", "pubsub", "observer",
              "refactor", "spaghetti", "connect", "wire", "system"],
     "text": "Decouple modules with a small EVENT BUS instead of importing each "
             "other. Ship one events.js — on(name, fn) / off(name, fn) / "
             "emit(name, data) over a {name: Set<fn>} map — and have modules talk "
             "through named events ('score-changed', 'player-hit'): the emitter "
             "never imports the listener. This keeps the dependency graph shallow "
             "(each file imports events.js, not its peers) so you can add or "
             "remove systems without touching the others."},
    {"scope": "web", "core": False,
     "tags": ["state", "store", "data", "global", "shared", "manager",
              "singleton", "save", "config", "architect", "source", "truth",
              "inventory", "progress"],
     "text": "Keep shared state in ONE store module — a single source of truth "
             "(ScriptableObject-style), not scattered globals or copies across "
             "files. Systems read from the store and emit events to change it; "
             "they never reach into each other to mutate state directly."},
    {"scope": "web", "core": True,
     "tags": ["engine", "game", "system", "glue", "spawn", "entity", "level",
              "gameplay", "mechanic", "player", "enemy", "weapon", "wire",
              "make", "build", "create", "platformer", "shooter", "runner",
              "camera", "view", "2d", "3d"],
     "text": "Building a game is the app's core job. If the project has an "
             "engine/ folder with a CONTRACTS.md, GLUE — don't rewrite. Read "
             "engine/CONTRACTS.md, then from the user's description pick a VIEW "
             "and a MOVEMENT component (top-down shooter -> cameras.topDown + "
             "movements.twinStick; platformer -> cameras.sideScroller + "
             "movements.platformer; endless runner -> movements.autoRun; true 2D "
             "-> cameras.flat2D) and set them in game/bootstrap.js. For a shooter "
             "also pick a WEAPON (weapons.single/rapid/shotgun/burst/radial) and "
             "an AIM (aim.stick/facing/manual/autoAim -- autoAim is best for "
             "one-thumb mobile). Give enemies/NPCs a brain with ctx.behavior "
             "(chase/flee/orbit/keepDistance/zigzag/charger for foes; "
             "wander/patrol/follow/guard for NPCs) or behaviors.byKind({...}) to "
             "mix types. Edit only "
             "game/ (contracts, entities, config, bootstrap) — tune the systems "
             "list, entities (mesh/color/stats), and numbers. Add a NEW system "
             "only for behavior no component provides (one small file, imports "
             "only core). Ask AT MOST 1-2 questions for genuinely ambiguous core "
             "choices (waves or endless? health or one-hit?), otherwise pick "
             "sensible defaults and build. Never re-implement the engine or add a "
             "3D library."},
]

_GAME_FILE_SIGNALS = ("babylon", "phaser", "three", "pixi", "kaboom", "<canvas",
                      "requestanimationframe", "playcanvas", "matter.js", "howler")
_GAME_TASK_WORDS = ("game", "joystick", "player", "sprite", "canvas", "level",
                    "enemy", "shoot", "jump", "3d", "2d", "multiplayer",
                    "physics", "collision", "score")
_WEB_TASK_WORDS = ("app", "ui", "screen", "page", "button", "form", "menu",
                   "layout", "web", "site", "mobile", "text", "font", "input",
                   "keyboard", "modal", "nav", "scroll", "theme", "css")


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    return Path(ws)


def _looks_like_game(root: Path) -> bool:
    try:
        for name in ("index.html", "game.js", "main.js", "index.htm"):
            fp = root / name
            if fp.exists():
                t = fp.read_text(encoding="utf-8", errors="replace").lower()
                if any(s in t for s in _GAME_FILE_SIGNALS):
                    return True
    except Exception:
        pass
    return False


def _has_web(root: Path) -> bool:
    try:
        for p in root.iterdir():
            if p.is_file() and p.suffix.lower() in (".html", ".htm"):
                return True
    except Exception:
        pass
    return False


def _task_is_gamey(task: str) -> bool:
    t = (task or "").lower()
    return any(w in t for w in _GAME_TASK_WORDS)


def _task_is_webby(task: str) -> bool:
    t = (task or "").lower()
    return any(w in t for w in _WEB_TASK_WORDS)


def _tokens(task: str) -> set:
    return set(re.findall(r"[a-z0-9]+", (task or "").lower()))


def _matches(practice: dict, words: set, text: str) -> bool:
    for tag in practice["tags"]:
        if tag.isalpha():
            for w in words:
                if w.startswith(tag):   # stem/prefix match: "mov" hits "moving"
                    return True
        elif tag in text:               # hyphenated / numeric tag → substring
            return True
    return False


def _pool(is_game: bool) -> list:
    return [p for p in PRACTICES if p["scope"] == "web" or
            (p["scope"] == "game" and is_game)]


def select(task: str = "", root: Path = None) -> list:
    """The practices to inject for this request: those whose tags appear in the
    message, or a small CORE set if none match. Empty for non-mobile projects."""
    root = root or _workspace()
    is_game = _looks_like_game(root) or _task_is_gamey(task)
    is_web = is_game or _has_web(root) or _task_is_webby(task)
    if not is_web:
        return []
    pool = _pool(is_game)
    words, text = _tokens(task), (task or "").lower()
    matched = [p for p in pool if _matches(p, words, text)]
    return matched or [p for p in pool if p.get("core")]


# --- user's global practices (persist across every project) -----------------

def user_file() -> Path:
    home = os.environ.get("HOME") or "/tmp"
    return Path(home) / "best_practices.md"


def get_user(_=None) -> str:
    fp = user_file()
    try:
        return fp.read_text(encoding="utf-8").strip() if fp.exists() else ""
    except Exception:
        return ""


def set_user(text="") -> str:
    try:
        user_file().write_text(str(text), encoding="utf-8")
        return "Saved your best practices"
    except Exception as e:
        return f"Save failed: {e}"


def add_user(text="") -> str:
    """Append one practice to the user's global list (from the app, hands-free)."""
    line = str(text).strip()
    if not line:
        return "(nothing to add)"
    if not line.startswith(("-", "*")):
        line = "- " + line
    cur = get_user()
    return set_user((cur + "\n" if cur else "") + line)


# --- rendering into context -------------------------------------------------

def render(task: str = "", root: Path = None) -> str:
    """The best-practices block for THIS request, or '' if nothing applies.
    User practices come last so they can override a built-in."""
    root = root or _workspace()
    parts = []
    picked = select(task, root)
    if picked:
        parts.append("Best practices for this request (apply them):\n- " +
                     "\n- ".join(p["text"] for p in picked))
    u = get_user()
    if u:
        parts.append("Your own best practices (these take priority):\n" + u)
    return "\n\n".join(parts)


def preview(task="") -> str:
    """The full playbook applicable to this project (for the app to show) — not
    tag-filtered, so the user sees everything that could apply."""
    root = _workspace()
    is_game = _looks_like_game(root) or _task_is_gamey(task)
    is_web = is_game or _has_web(root) or _task_is_webby(task)
    parts = []
    if is_web:
        parts.append("Applies to this project (injected per request by relevance):"
                     "\n- " + "\n- ".join(p["text"] for p in _pool(is_game)))
    u = get_user()
    if u:
        parts.append("Your own best practices (always applied):\n" + u)
    return "\n\n".join(parts) or "(no best practices apply to this project yet)"
