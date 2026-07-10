"""
templates.py — starter project scaffolds seeded into a workspace.

A template is {id, name, description, files: {relpath: content}}. apply_template
writes the files into the active workspace (skipping any that already exist), so
a fresh session + a template = an instant, on-convention starting point. Each
template ships a guidelines.md so the per-project memory keeps the agent on the
stack (small files, CDN libraries) — which is also the token-efficient path.

This module is OTA-updatable (listed in agent_loader._MODULES); the orchestrator
exposes list_templates / apply_template via op().
"""

import os
import json
from pathlib import Path


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    p = Path(ws)
    p.mkdir(parents=True, exist_ok=True)
    return p


# --- Babylon.js + PeerJS 3D multiplayer starter ------------------------------

_BABYLON_INDEX = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
  <title>3D Multiplayer</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0d12; }
    #c { width: 100%; height: 100%; display: block; touch-action: none; }
    #ui { position: fixed; top: 8px; left: 8px; z-index: 10; color: #fff;
          font: 14px system-ui, sans-serif; }
    #ui button, #ui input { font-size: 14px; padding: 4px 8px; margin: 2px 0; }
    #ui input { width: 130px; }
    #status { margin-top: 4px; opacity: .8; }
    .code { font-weight: 700; color: #6cf; }
  </style>
  <!-- Libraries loaded from pinned CDNs — never vendored into the repo. -->
  <script src="https://cdn.jsdelivr.net/npm/babylonjs@7/babylon.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js"></script>
</head>
<body>
  <div id="ui">
    <div>Room: <span id="room" class="code">—</span></div>
    <button id="host">Host game</button>
    <input id="join-code" placeholder="room code" />
    <button id="join">Join</button>
    <div id="status">move with WASD / arrows</div>
  </div>
  <canvas id="c"></canvas>
  <script src="game.js"></script>
  <script src="net.js"></script>
  <script>startGame();</script>
</body>
</html>
"""

_BABYLON_GAME = """// game.js — Babylon.js scene, local player, remote players.
// Exposes a small `Game` API that net.js uses to read/apply player state.
let Game = null;

function startGame() {
  const canvas = document.getElementById("c");
  const engine = new BABYLON.Engine(canvas, true);
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color3(0.04, 0.05, 0.08);

  const cam = new BABYLON.ArcRotateCamera("cam", -Math.PI / 2, 1.05, 20,
    BABYLON.Vector3.Zero(), scene);
  cam.attachControl(canvas, true);
  new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

  const ground = BABYLON.MeshBuilder.CreateGround("g", { width: 30, height: 30 }, scene);
  const gmat = new BABYLON.StandardMaterial("gmat", scene);
  gmat.diffuseColor = new BABYLON.Color3(0.14, 0.18, 0.24);
  ground.material = gmat;

  function makeBox(r, g, b) {
    const box = BABYLON.MeshBuilder.CreateBox("p", { size: 1 }, scene);
    box.position.y = 0.5;
    const m = new BABYLON.StandardMaterial("m", scene);
    m.diffuseColor = new BABYLON.Color3(r, g, b);
    box.material = m;
    return box;
  }

  const me = makeBox(0.3, 0.8, 1.0);   // local player (blue)
  const remotes = {};                  // peerId -> box (orange)

  const input = {};
  addEventListener("keydown", (e) => (input[e.key.toLowerCase()] = true));
  addEventListener("keyup", (e) => (input[e.key.toLowerCase()] = false));

  scene.onBeforeRenderObservable.add(() => {
    const s = 0.15;
    if (input["w"] || input["arrowup"]) me.position.z += s;
    if (input["s"] || input["arrowdown"]) me.position.z -= s;
    if (input["a"] || input["arrowleft"]) me.position.x -= s;
    if (input["d"] || input["arrowright"]) me.position.x += s;
  });

  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());

  Game = {
    myState: () => ({ x: me.position.x, z: me.position.z }),
    setRemote: (id, st) => {
      let b = remotes[id] || (remotes[id] = makeBox(1.0, 0.5, 0.25));
      b.position.x = st.x;
      b.position.z = st.z;
    },
    dropRemote: (id) => {
      if (remotes[id]) { remotes[id].dispose(); delete remotes[id]; }
    },
  };
}
"""

_BABYLON_NET = """// net.js — PeerJS peer-to-peer networking. No server: the host's peer id
// IS the room code; others connect to it. Player state syncs on a fixed tick.
(function () {
  let peer = null;
  const conns = {}; // peerId -> DataConnection
  const $ = (id) => document.getElementById(id);
  const status = (t) => ($("status").textContent = t);

  function wire(conn) {
    conns[conn.peer] = conn;
    conn.on("data", (d) => {
      if (d && d.t === "state" && window.Game) Game.setRemote(conn.peer, d.s);
    });
    conn.on("close", () => {
      delete conns[conn.peer];
      if (window.Game) Game.dropRemote(conn.peer);
    });
  }

  function startNet(connectTo) {
    peer = new Peer(); // random id = the room code
    peer.on("open", (id) => {
      $("room").textContent = id;
      status(connectTo ? "connecting…" : "hosting — share the room code");
      if (connectTo) {
        const c = peer.connect(connectTo);
        c.on("open", () => { wire(c); status("connected"); });
      }
    });
    peer.on("connection", (conn) => conn.on("open", () => wire(conn)));
    peer.on("error", (e) => status("error: " + e.type));

    // Broadcast my state to everyone I'm connected to, ~16x/sec.
    setInterval(() => {
      if (!window.Game) return;
      const msg = { t: "state", s: Game.myState() };
      for (const k in conns) { try { conns[k].send(msg); } catch (e) {} }
    }, 60);
  }

  $("host").onclick = () => startNet(null);
  $("join").onclick = () => {
    const code = $("join-code").value.trim();
    if (code) startNet(code);
  };
})();
"""

_BABYLON_GUIDELINES = """# 3D multiplayer starter — Babylon.js + PeerJS

Stack (all CDN-loaded, NEVER vendored into the repo):
- Babylon.js — 3D rendering
- PeerJS — peer-to-peer networking (no server to host)

Files (one small file per feature):
- index.html — loads the CDNs, the canvas + room UI, and calls startGame()
- game.js   — Babylon scene, local player (WASD/arrows), remote players; exposes `Game`
- net.js    — PeerJS: Host creates a room (its peer id is the room code); Join
              connects to a code. Player state syncs on a 60ms tick.

Conventions:
- Keep each feature in its own small file; reference libraries by CDN, never paste
  their source.
- Topology is a star (host + joiners). For 3+ players who all see each other,
  relay state through the host or build a full mesh in net.js.
- P2P has no server authority (no anti-cheat). If you need that, move networking
  to Colyseus (a small hosted server) and keep game.js as-is.
"""

# --- smaller starters --------------------------------------------------------

_STATIC_INDEX = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My App</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main><h1>Hello</h1><p>Edit the files and press Run to preview.</p></main>
  <script src="app.js"></script>
</body>
</html>
"""

_STATIC_CSS = """body { font: 16px system-ui, sans-serif; margin: 2rem; color: #123; }
h1 { color: #06c; }
"""

_STATIC_JS = "console.log('app ready');\n"

_WSGI_APP = """# app.py — a tiny WSGI app the on-device preview can run.
# Expose a callable named `app`; press Run to serve it.

def app(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/html; charset=utf-8")])
    return [b"<h1>Hello from your Python app</h1><p>Edit app.py and Run again.</p>"]
"""

_PHASER_INDEX = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
  <title>2D Game</title>
  <style>html,body{margin:0;height:100%;background:#111;overflow:hidden}</style>
  <script src="https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js"></script>
</head>
<body>
  <script src="game.js"></script>
</body>
</html>
"""

_PHASER_GAME = """// game.js — minimal Phaser 3 scene.
const config = {
  type: Phaser.AUTO, width: window.innerWidth, height: window.innerHeight,
  backgroundColor: "#1d2330", physics: { default: "arcade" },
  scene: { create, update },
};
let player, cursors;
function create() {
  player = this.add.rectangle(this.scale.width / 2, this.scale.height / 2, 40, 40, 0x4cc2ff);
  this.physics.add.existing(player);
  cursors = this.input.keyboard.createCursorKeys();
}
function update() {
  const b = player.body, s = 220;
  b.setVelocity(0);
  if (cursors.left.isDown) b.setVelocityX(-s);
  if (cursors.right.isDown) b.setVelocityX(s);
  if (cursors.up.isDown) b.setVelocityY(-s);
  if (cursors.down.isDown) b.setVelocityY(s);
}
new Phaser.Game(config);
"""


_CHAT_INDEX = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
  <title>Chat</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div id="messages"></div>
  <footer id="bar">
    <input id="input" type="text" placeholder="Type a message…" autocomplete="off" />
    <button id="send">Send</button>
  </footer>
  <script src="app.js"></script>
</body>
</html>
"""

_CHAT_CSS = """*{box-sizing:border-box;}
body{margin:0;height:100vh;display:flex;flex-direction:column;font:15px system-ui,sans-serif;background:#f5f5f5;}
#messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;}
.msg{max-width:80%;padding:10px 14px;border-radius:16px;word-wrap:break-word;line-height:1.35;}
.msg.me{background:#0b57d0;color:#fff;align-self:flex-end;border-bottom-right-radius:4px;}
.msg.other{background:#e8eaed;color:#1f1f1f;align-self:flex-start;border-bottom-left-radius:4px;}
#bar{display:flex;gap:8px;padding:10px;border-top:1px solid #ddd;background:#fff;}
#bar input{flex:1;border:1px solid #ddd;border-radius:20px;padding:8px 14px;font:inherit;outline:none;}
#bar input:focus{border-color:#0b57d0;}
#bar button{background:#0b57d0;color:#fff;border:0;border-radius:20px;padding:8px 16px;font-weight:600;}
"""

_CHAT_JS = """const input = document.getElementById("input");
const msgs = document.getElementById("messages");
document.getElementById("send").onclick = () => {
  const t = input.value.trim(); if (!t) return;
  const d = document.createElement("div"); d.className = "msg me"; d.textContent = t;
  msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
  input.value = "";
};
input.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("send").click(); });
"""

_WEBGAME_INDEX = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>Canvas Game</title>
  <style>
    html,body{margin:0;height:100%;overflow:hidden;background:#0f1117;touch-action:none;}
    canvas{display:block;width:100%;height:100%}
    #hud{position:fixed;top:10px;left:10px;color:#eef;font:600 14px system-ui,sans-serif;pointer-events:none;text-shadow:0 1px 3px #000;}
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div id="hud">use WASD/arrows</div>
  <script>
    // A minimal canvas game loop with input and delta time.
    const canvas = document.getElementById("c"), ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;

    const keys = {};
    addEventListener("keydown", e => keys[e.key.toLowerCase()] = true);
    addEventListener("keyup", e => keys[e.key.toLowerCase()] = false);
    addEventListener("resize", () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });

    let px = canvas.width/2, py = canvas.height/2, lastTime = 0;

    function loop(time) {
      const dt = lastTime ? (time - lastTime) / 1000 : 1/60;
      lastTime = time;

      const speed = 200 * dt;
      if (keys["w"] || keys["arrowup"]) py -= speed;
      if (keys["s"] || keys["arrowdown"]) py += speed;
      if (keys["a"] || keys["arrowleft"]) px -= speed;
      if (keys["d"] || keys["arrowright"]) px += speed;

      ctx.fillStyle = "#0f1117";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#4cc2ff";
      ctx.beginPath();
      ctx.arc(px, py, 16, 0, Math.PI * 2);
      ctx.fill();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  </script>
</body>
</html>
"""

TEMPLATES = [
    {
        "id": "babylon-peerjs",
        "name": "3D multiplayer (Babylon.js + PeerJS)",
        "description": "Babylon 3D scene + peer-to-peer multiplayer, no server. Host/join by room code.",
        "files": {
            "index.html": _BABYLON_INDEX,
            "game.js": _BABYLON_GAME,
            "net.js": _BABYLON_NET,
            "guidelines.md": _BABYLON_GUIDELINES,
        },
    },
    {
        "id": "web-game",
        "name": "Canvas game (vanilla JS)",
        "description": "Minimal canvas game with arrow-key movement, delta-time loop, and resize.",
        "files": {"index.html": _WEBGAME_INDEX},
    },
    {
        "id": "phaser-2d",
        "name": "2D game (Phaser)",
        "description": "A minimal Phaser 3 scene with a movable player. CDN-loaded.",
        "files": {"index.html": _PHASER_INDEX, "game.js": _PHASER_GAME},
    },
    {
        "id": "chat-ui",
        "name": "Chat UI (HTML/CSS)",
        "description": "A chat interface like the VoiceAgent UI. Bubble layout, text input, messages.",
        "files": {"index.html": _CHAT_INDEX, "style.css": _CHAT_CSS, "app.js": _CHAT_JS},
    },
    {
        "id": "static-web",
        "name": "Static web app",
        "description": "Plain index.html + style.css + app.js. Previews on-device.",
        "files": {"index.html": _STATIC_INDEX, "style.css": _STATIC_CSS, "app.js": _STATIC_JS},
    },
    {
        "id": "python-wsgi",
        "name": "Python web app (WSGI)",
        "description": "A tiny app.py WSGI app the on-device preview runs.",
        "files": {"app.py": _WSGI_APP},
    },
]


# Our own event-driven low-poly 3D engine (no third-party 3D lib). It ships as a
# bundle in engine3d.py; the AI GLUES against engine/CONTRACTS.md rather than
# rewriting the engine each game. Imported defensively so templates still work if
# the (OTA) engine3d module isn't present in an older build.
try:
    import engine3d
    TEMPLATES.insert(0, {
        "id": "engine-3d",
        "name": "3D game (our engine, low-poly)",
        "description": "Our own event-driven WebGL engine + a playable twin-stick "
                       "shooter. Systems are decoupled; you glue, not rewrite.",
        "files": dict(engine3d.FILES),
    })
except Exception:
    pass


def list_templates(_=None) -> str:
    return json.dumps([{k: t[k] for k in ("id", "name", "description")}
                       for t in TEMPLATES])


def apply_template(template_id="") -> str:
    tid = str(template_id).strip()
    t = next((x for x in TEMPLATES if x["id"] == tid), None)
    if not t:
        return f"(no such template: {tid})"
    root = _workspace()
    created, skipped = [], []
    for rel, content in t["files"].items():
        fp = root / rel
        if fp.exists():
            skipped.append(rel)
            continue
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")
        created.append(rel)
    msg = f"Applied '{t['name']}' — created {len(created)} file(s)"
    if created:
        msg += ": " + ", ".join(created)
    if skipped:
        msg += f" (skipped existing: {', '.join(skipped)})"
    return msg
