// engine/render/gl.js
// The whole renderer, and the ONLY file that touches WebGL. It draws each scene
// entity as a flat-shaded primitive under one directional light, with a camera
// you point via setCamera(). Swap this one file to change the whole look —
// nothing else in the engine or the game references WebGL or matrices.
import { MESHES } from './meshes.js';
import { mat4 } from '../core/math3.js';

const VERT = [
  'attribute vec3 aPos;',
  'attribute vec3 aNormal;',
  'uniform mat4 uMVP;',
  'uniform mat3 uNormal;',
  'varying vec3 vN;',
  'void main() {',
  '  vN = normalize(uNormal * aNormal);',
  '  gl_Position = uMVP * vec4(aPos, 1.0);',
  '}',
].join('\n');

const FRAG = [
  'precision mediump float;',
  'varying vec3 vN;',
  'uniform vec3 uColor;',
  'uniform vec3 uLight;',
  'void main() {',
  '  float d = max(dot(normalize(vN), normalize(uLight)), 0.0);',
  '  gl_FragColor = vec4(uColor * (0.35 + 0.75 * d), 1.0);',
  '}',
].join('\n');

let gl, prog, loc, canvas;
const buffers = {};
const cam = { eye: [0, 20, 14], target: [0, 0, 0], up: [0, 1, 0], projection: 'perspective', orthoSize: 20 };
const LIGHT = [0.4, 1.0, 0.6];

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export function initRenderer(cv) {
  canvas = cv;
  gl = cv.getContext('webgl', { antialias: true });
  if (!gl) throw new Error('WebGL not available');
  prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  loc = {
    aPos: gl.getAttribLocation(prog, 'aPos'),
    aNormal: gl.getAttribLocation(prog, 'aNormal'),
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    uNormal: gl.getUniformLocation(prog, 'uNormal'),
    uColor: gl.getUniformLocation(prog, 'uColor'),
    uLight: gl.getUniformLocation(prog, 'uLight'),
  };
  for (const name in MESHES) {
    const m = MESHES[name];
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(m.positions), gl.STATIC_DRAW);
    const nrm = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(m.normals), gl.STATIC_DRAW);
    buffers[name] = { pos, nrm, count: m.positions.length / 3 };
  }
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.07, 0.08, 0.12, 1);
  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
}

// Point the camera. `c` comes from a camera controller (see cameras.js):
// { eye, target, up?, projection? ('perspective'|'ortho'), orthoSize? }.
export function applyCamera(c) {
  cam.eye = c.eye;
  cam.target = c.target;
  cam.up = c.up || [0, 1, 0];
  cam.projection = c.projection || 'perspective';
  if (c.orthoSize) cam.orthoSize = c.orthoSize;
}

export function render(scene) {
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const aspect = canvas.width / Math.max(canvas.height, 1);
  const proj = cam.projection === 'ortho'
    ? mat4.ortho(-cam.orthoSize * aspect, cam.orthoSize * aspect, -cam.orthoSize, cam.orthoSize, 0.1, 1000)
    : mat4.perspective(Math.PI / 4, aspect, 0.1, 500);
  const vp = mat4.multiply(proj, mat4.lookAt(cam.eye, cam.target, cam.up));
  gl.uniform3fv(loc.uLight, LIGHT);
  scene.each((e) => {
    if (e.dead) return;
    const buf = buffers[e.mesh] || buffers.box;
    const sc = typeof e.scale === 'number' ? [e.scale, e.scale, e.scale] : e.scale;
    let model = mat4.multiply(mat4.translate(e.pos[0], e.pos[1], e.pos[2]), mat4.rotateY(e.rot || 0));
    model = mat4.multiply(model, mat4.scale(sc[0], sc[1], sc[2]));
    gl.uniformMatrix4fv(loc.uMVP, false, mat4.multiply(vp, model));
    gl.uniformMatrix3fv(loc.uNormal, false, mat4.normal3(model));
    gl.uniform3fv(loc.uColor, e.color);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.nrm);
    gl.enableVertexAttribArray(loc.aNormal);
    gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, buf.count);
  });
}
