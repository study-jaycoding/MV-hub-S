import type { AtlasRegion, AtlasUploader, CardAtlas } from "./cardAtlas";

export type GpuColor = [number, number, number, number];
export interface GpuCamera { z: number; x: number; y: number; dpr: number; width: number; height: number }
export interface GpuCardInstance { id: string; x: number; y: number; w: number; h: number; radius: number; border: GpuColor; borderWidth: number; hidden: boolean; z: number }
// 굵기·대시·점 반지름은 월드 단위다 — DOM 의 연결선 SVG·끝 점이 카메라 층 안에 있어 배율에 따라 같이 굵어지고 가늘어진다.
//  화면에서 1px 보다 가늘어지면 1px 로 그리고 그만큼 옅게(브라우저가 가는 SVG 선을 옅게 그리는 것과 같은 인상).
export interface GpuLine { points: Float32Array; color: GpuColor; width: number; dash: number; gap?: number }
export interface GpuRect { x: number; y: number; w: number; h: number; radius: number; fill: GpuColor; border: GpuColor; borderWidth: number }
// hideLow = 25% 이하 단순화에서 숨기는 조각(GpuBoard 가 setScene 전에 거른다)
export interface GpuDot { x: number; y: number; r: number; fill: GpuColor; border: GpuColor; hideLow?: boolean }
export interface GpuQuad { id: string; x: number; y: number; w: number; h: number; hideLow?: boolean }
export interface GpuScene {
  cards: GpuCardInstance[];
  lines: GpuLine[];
  rects: GpuRect[];
  dots: GpuDot[];
  quads: GpuQuad[];
  selection?: GpuRect[];
  gridColor?: GpuColor;
}
export interface GpuRenderer extends AtlasUploader {
  setScene(s: GpuScene): void;
  /** 덧판이 덮는 카드 한 장만 감추거나(null = 되살림) — 버퍼 전체를 다시 채우지 않고 그 카드 칸만 고친다 */
  setHidden(id: string | null): void;
  draw(camera: GpuCamera, lookup: CardAtlas["lookup"]): void;
  timeGpu(frames: number): Promise<number[]>;
  textureBytes(): number;
  lost(): boolean;
  destroy(): void;
}

const unitVertices = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
const transparent: GpuColor = [0, 0, 0, 0];
const cameraUniforms = `uniform vec3 camera; uniform vec2 viewport;`;
const quadVertex = `#version 300 es
layout(location=0) in vec2 unit;
void main() { gl_Position = vec4(unit * 2.0 - 1.0, 0, 1); }`;
const gridFragment = `#version 300 es
precision highp float;
${cameraUniforms}
uniform float dpr; uniform vec4 color;
out vec4 outColor;
void main() {
  vec2 p = vec2(gl_FragCoord.x / dpr, viewport.y - gl_FragCoord.y / dpr);
  vec2 q = mod(p - camera.yz - vec2(1.0) + 11.0, 22.0) - 11.0;
  float a = color.a * (1.0 - smoothstep(0.65, 1.15, length(q)));
  outColor = vec4(color.rgb * a, a);
}`;
const shapeVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 unit;
layout(location=1) in vec4 box;
layout(location=2) in vec3 style;
layout(location=3) in vec4 fill;
layout(location=4) in vec4 border;
layout(location=5) in vec4 uv;
${cameraUniforms}
out vec2 local; out vec2 texCoord;
flat out vec2 extent; flat out vec2 edge;
flat out vec4 fillColor; flat out vec4 borderColor;
void main() {
  bool dot = style.z > 0.5;
  extent = box.zw * (dot ? 1.0 : camera.x);
  local = unit * extent;
  edge = style.xy * (dot ? 1.0 : camera.x);
  vec2 p = box.xy * camera.x + camera.yz + local - (dot ? extent * 0.5 : vec2(0));
  gl_Position = vec4(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0, 0, 1);
  texCoord = mix(uv.xy, uv.zw, unit);
  fillColor = fill; borderColor = border;
}`;
const shapeFragment = `#version 300 es
precision highp float;
uniform sampler2D atlas; uniform bool textured;
in vec2 local; in vec2 texCoord;
flat in vec2 extent; flat in vec2 edge;
flat in vec4 fillColor; flat in vec4 borderColor;
out vec4 outColor;
void main() {
  float r = min(edge.x, min(extent.x, extent.y) * 0.5);
  vec2 q = abs(local - extent * 0.5) - extent * 0.5 + r;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float aa = max(fwidth(distance), 0.001);
  float coverage = 1.0 - smoothstep(-aa, 0.0, distance);
  vec4 c = textured ? texture(atlas, texCoord) : fillColor;
  c = vec4(c.rgb * c.a, c.a);
  float b = edge.y > 0.0 ? smoothstep(-edge.y - aa, -edge.y, distance) * borderColor.a : 0.0;
  c = vec4(borderColor.rgb * b, b) + c * (1.0 - b);
  outColor = c * coverage;
}`;
const lineVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 point;
layout(location=1) in vec2 normal;
layout(location=2) in vec3 metrics;
layout(location=3) in vec4 color;
layout(location=4) in float dash;
layout(location=5) in float gap;
${cameraUniforms}
out float distance; flat out float dashLength; flat out float gapLength; flat out vec4 lineColor;
void main() {
  float screenWidth = metrics.z * camera.x;
  vec2 p = point * camera.x + camera.yz + normal * metrics.x * max(screenWidth, 1.0) * 0.5;
  gl_Position = vec4(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0, 0, 1);
  distance = metrics.y; dashLength = dash; gapLength = gap;
  lineColor = vec4(color.rgb, color.a * min(screenWidth, 1.0));
}`;
const lineFragment = `#version 300 es
precision highp float;
in float distance; flat in float dashLength; flat in float gapLength; flat in vec4 lineColor;
out vec4 outColor;
void main() {
  if (dashLength > 0.0 && mod(distance, dashLength + gapLength) >= dashLength) discard;
  outColor = vec4(lineColor.rgb * lineColor.a, lineColor.a);
}`;

type Program = { value: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };
type Shape = { id?: string; page: number; region: AtlasRegion | null };
type Range = { start: number; count: number };
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export function createGpuRenderer(canvas: HTMLCanvasElement, opts: { onContextLost?: () => void } = {}): GpuRenderer | null {
  let gl: WebGL2RenderingContext | null;
  try { gl = canvas.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true }); }
  catch { return null; }
  if (!gl) return null;
  const g = gl;
  const programs: WebGLProgram[] = [];
  const shaders: WebGLShader[] = [];
  const buffers: WebGLBuffer[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  const textures = new Map<number, { value: WebGLTexture; size: number }>();
  const queries = new Set<WebGLQuery>();
  let dead = false, contextLost = false;
  let stopTiming: (() => void) | null = null;
  let timing: Promise<number[]> | null = null;
  let last: { camera: GpuCamera; lookup: CardAtlas["lookup"] } | null = null;

  function cleanup() {
    stopTiming?.();
    for (const t of textures.values()) g.deleteTexture(t.value);
    for (const q of queries) g.deleteQuery(q);
    for (const b of buffers) g.deleteBuffer(b);
    for (const p of programs) g.deleteProgram(p);
    for (const s of shaders) g.deleteShader(s);
    for (const v of vaos) g.deleteVertexArray(v);
    textures.clear(); queries.clear(); buffers.length = 0; programs.length = 0; shaders.length = 0; vaos.length = 0;
    last = null;
  }

  function onLost(event: Event) {
    event.preventDefault();
    if (contextLost || dead) return;
    contextLost = true;
    stopTiming?.();
    opts.onContextLost?.();
  }

  try {
    function program(vs: string, fs: string): Program {
      const p = g.createProgram();
      if (!p) throw new Error("GPU program unavailable");
      programs.push(p);
      for (const [kind, source] of [[g.VERTEX_SHADER, vs], [g.FRAGMENT_SHADER, fs]] as const) {
        const s = g.createShader(kind);
        if (!s) throw new Error("GPU shader unavailable");
        shaders.push(s);
        g.shaderSource(s, source);
        g.compileShader(s);
        if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error("GPU shader compilation failed");
        g.attachShader(p, s);
      }
      g.linkProgram(p);
      if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error("GPU program link failed");
      return { value: p, uniforms: new Map() };
    }
    const shapeProgram = program(shapeVertex, shapeFragment);
    const lineProgram = program(lineVertex, lineFragment);
    const gridProgram = program(quadVertex, gridFragment);
    function buffer() {
      const b = g.createBuffer();
      if (!b) throw new Error("GPU buffer unavailable");
      buffers.push(b);
      return b;
    }
    function vao() {
      const v = g.createVertexArray();
      if (!v) throw new Error("GPU vertex array unavailable");
      vaos.push(v);
      return v;
    }
    function attribute(index: number, size: number, stride: number, offset: number, divisor = 0) {
      g.enableVertexAttribArray(index);
      g.vertexAttribPointer(index, size, g.FLOAT, false, stride * 4, offset * 4);
      g.vertexAttribDivisor(index, divisor);
    }
    function uniform(p: Program, name: string) {
      if (!p.uniforms.has(name)) p.uniforms.set(name, g.getUniformLocation(p.value, name));
      return p.uniforms.get(name)!;
    }
    function use(p: Program, camera: GpuCamera) {
      g.useProgram(p.value);
      g.uniform3f(uniform(p, "camera"), camera.z, camera.x, camera.y);
      g.uniform2f(uniform(p, "viewport"), camera.width, camera.height);
    }
    const unitBuffer = buffer(), shapeBuffer = buffer(), uvBuffer = buffer(), lineBuffer = buffer();
    const shapeVao = vao(), gridVao = vao(), lineVao = vao();
    g.bindBuffer(g.ARRAY_BUFFER, unitBuffer);
    g.bufferData(g.ARRAY_BUFFER, unitVertices, g.STATIC_DRAW);
    for (const v of [shapeVao, gridVao]) {
      g.bindVertexArray(v);
      attribute(0, 2, 2, 0);
    }
    g.bindVertexArray(lineVao);
    g.bindBuffer(g.ARRAY_BUFFER, lineBuffer);
    attribute(0, 2, 13, 0); attribute(1, 2, 13, 2); attribute(2, 3, 13, 4);
    attribute(3, 4, 13, 7); attribute(4, 1, 13, 11); attribute(5, 1, 13, 12);
    g.bindVertexArray(null);
    let shapes: Shape[] = [];
    let uvs = new Float32Array();
    let shapeData = new Float32Array(); // 지금 버퍼에 든 모양 자료(감춤 되살리기용)
    const cardIndex = new Map<string, number>(); // 카드 id → 모양 칸
    let hiddenIndex = -1;
    let rects: Range = { start: 0, count: 0 }, cards = rects, selection = rects, dots = rects, quads = rects;
    let lineCount = 0;
    let gridColor: GpuColor = [1, 1, 1, 0.11];
    const extension = g.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExtension | null;

    function shapeRange(range: Range, camera: GpuCamera) {
      if (!range.count) return;
      use(shapeProgram, camera);
      g.bindVertexArray(shapeVao);
      g.uniform1i(uniform(shapeProgram, "atlas"), 0);
      for (let start = range.start; start < range.start + range.count;) {
        const page = shapes[start].page;
        let end = start + 1;
        while (end < range.start + range.count && shapes[end].page === page) end++;
        g.bindBuffer(g.ARRAY_BUFFER, shapeBuffer);
        attribute(1, 4, 15, start * 15, 1);
        attribute(2, 3, 15, start * 15 + 4, 1);
        attribute(3, 4, 15, start * 15 + 7, 1);
        attribute(4, 4, 15, start * 15 + 11, 1);
        g.bindBuffer(g.ARRAY_BUFFER, uvBuffer);
        attribute(5, 4, 4, start * 4, 1);
        const texture = textures.get(page);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, texture?.value ?? null);
        g.uniform1i(uniform(shapeProgram, "textured"), texture ? 1 : 0);
        g.drawArraysInstanced(g.TRIANGLES, 0, 6, end - start);
        start = end;
      }
    }

    const renderer: GpuRenderer = {
      ensurePage(page, size) {
        if (dead || contextLost) return;
        const old = textures.get(page);
        if (old) { if (old.size !== size) throw new Error("Atlas page size changed"); return; }
        if (!Number.isInteger(size) || size < 1 || size > g.getParameter(g.MAX_TEXTURE_SIZE)) throw new RangeError("GPU texture size unsupported");
        if (renderer.textureBytes() + size * size * 4 > 128 * 1024 * 1024) throw new RangeError("GPU texture budget exhausted");
        const t = g.createTexture();
        if (!t) throw new Error("GPU texture unavailable");
        try {
          g.bindTexture(g.TEXTURE_2D, t);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
          g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA8, size, size);
          if (g.getError() !== g.NO_ERROR) throw new Error("GPU texture allocation failed");
          textures.set(page, { value: t, size });
        } catch (error) { g.deleteTexture(t); throw error; }
      },
      upload(page, x, y, source, w, h) {
        if (dead || contextLost) return;
        const t = textures.get(page);
        if (!t || x < 0 || y < 0 || w < 1 || h < 1 || x + w > t.size || y + h > t.size || source.width !== w || source.height !== h) throw new RangeError("Invalid atlas upload");
        g.bindTexture(g.TEXTURE_2D, t.value);
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
        g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        g.texSubImage2D(g.TEXTURE_2D, 0, x, y, g.RGBA, g.UNSIGNED_BYTE, source);
        if (g.getError() !== g.NO_ERROR) throw new Error("GPU texture upload failed");
      },
      deletePage(page) {
        const t = textures.get(page);
        if (t) { g.deleteTexture(t.value); textures.delete(page); }
      },
      setScene(s) {
        if (dead || contextLost) return;
        const data: number[] = [];
        shapes = [];
        function add(r: GpuRect, id?: string, dot = false) {
          data.push(r.x, r.y, r.w, r.h, r.radius, r.borderWidth, Number(dot), ...r.fill, ...r.border);
          shapes.push({ id, page: -1, region: null });
        }
        function range(build: () => void): Range {
          const start = shapes.length;
          build();
          return { start, count: shapes.length - start };
        }
        rects = range(() => s.rects.forEach((r) => add(r)));
        cards = range(() => s.cards.filter((c) => !c.hidden).sort((a, b) => a.z - b.z).forEach((c) => add({ ...c, fill: [0.08, 0.09, 0.11, 1] }, c.id)));
        selection = range(() => s.selection?.forEach((r) => add(r)));
        // 끝 점(.scene-dot r=5, 테두리 2 가운데 걸침) — 월드 크기라 바깥 반지름 r+1·테두리 2
        dots = range(() => s.dots.forEach((d) => add({ x: d.x - d.r - 1, y: d.y - d.r - 1, w: d.r * 2 + 2, h: d.r * 2 + 2, radius: d.r + 1, borderWidth: 2, fill: d.fill, border: d.border })));
        quads = range(() => s.quads.forEach((q) => add({ ...q, radius: 0, borderWidth: 0, fill: transparent, border: transparent }, q.id)));
        uvs = new Float32Array(shapes.length * 4);
        shapeData = new Float32Array(data);
        cardIndex.clear();
        for (let i = cards.start; i < cards.start + cards.count; i++) cardIndex.set(shapes[i].id!, i);
        hiddenIndex = -1;
        g.bindBuffer(g.ARRAY_BUFFER, shapeBuffer);
        g.bufferData(g.ARRAY_BUFFER, shapeData, g.DYNAMIC_DRAW);
        g.bindBuffer(g.ARRAY_BUFFER, uvBuffer);
        g.bufferData(g.ARRAY_BUFFER, uvs, g.DYNAMIC_DRAW);
        const vertices: number[] = [];
        for (const line of s.lines) {
          let distance = 0;
          for (let i = 2; i + 1 < line.points.length; i += 2) {
            const ax = line.points[i - 2], ay = line.points[i - 1], bx = line.points[i], by = line.points[i + 1];
            const length = Math.hypot(bx - ax, by - ay);
            if (!length) continue;
            const nx = -(by - ay) / length, ny = (bx - ax) / length;
            for (const [end, side] of [[0, -1], [1, -1], [0, 1], [0, 1], [1, -1], [1, 1]]) {
              vertices.push(end ? bx : ax, end ? by : ay, nx, ny, side, distance + end * length, line.width, ...line.color, line.dash, line.gap ?? line.dash);
            }
            distance += length;
          }
        }
        lineCount = vertices.length / 13;
        g.bindBuffer(g.ARRAY_BUFFER, lineBuffer);
        g.bufferData(g.ARRAY_BUFFER, new Float32Array(vertices), g.DYNAMIC_DRAW);
        gridColor = s.gridColor ?? [1, 1, 1, 0.11];
      },
      setHidden(id) {
        if (dead || contextLost) return;
        const next = id === null ? -1 : cardIndex.get(id) ?? -1;
        if (next === hiddenIndex) return;
        g.bindBuffer(g.ARRAY_BUFFER, shapeBuffer);
        // 모양 칸 = x,y,w,h,반지름,테두리,점,채움4,테두리색4 (15칸) — w·h 를 0 으로 두면 그 카드는 그려지지 않는다
        if (hiddenIndex >= 0) g.bufferSubData(g.ARRAY_BUFFER, (hiddenIndex * 15 + 2) * 4, shapeData.subarray(hiddenIndex * 15 + 2, hiddenIndex * 15 + 4));
        if (next >= 0) g.bufferSubData(g.ARRAY_BUFFER, (next * 15 + 2) * 4, new Float32Array([0, 0]));
        hiddenIndex = next;
      },
      draw(camera, lookup) {
        if (dead || contextLost || camera.width <= 0 || camera.height <= 0 || camera.z <= 0 || camera.dpr <= 0) return;
        last = { camera: { ...camera }, lookup };
        const width = Math.max(1, Math.round(camera.width * camera.dpr)), height = Math.max(1, Math.round(camera.height * camera.dpr));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        let first = shapes.length, end = 0;
        shapes.forEach((shape, i) => {
          if (shape.id === undefined) return;
          const r = lookup(shape.id);
          const old = shape.region;
          if (r?.page === old?.page && r?.u0 === old?.u0 && r?.v0 === old?.v0 && r?.u1 === old?.u1 && r?.v1 === old?.v1) return;
          shape.region = r ? { ...r } : null;
          shape.page = r?.page ?? -1;
          uvs.set(r ? [r.u0, r.v0, r.u1, r.v1] : [0, 0, 0, 0], i * 4);
          first = Math.min(first, i); end = i + 1;
        });
        // 새 아틀라스가 준비된 때만 UV를 바꾸고 카메라 이동은 유니폼으로 끝낸다.
        if (first < end) {
          g.bindBuffer(g.ARRAY_BUFFER, uvBuffer);
          g.bufferSubData(g.ARRAY_BUFFER, first * 16, uvs.subarray(first * 4, end * 4));
        }
        g.viewport(0, 0, width, height);
        g.disable(g.DEPTH_TEST);
        g.enable(g.BLEND);
        g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
        g.clearColor(0, 0, 0, 0);
        g.clear(g.COLOR_BUFFER_BIT);
        use(gridProgram, camera);
        g.uniform1f(uniform(gridProgram, "dpr"), camera.dpr);
        g.uniform4fv(uniform(gridProgram, "color"), gridColor);
        g.bindVertexArray(gridVao);
        g.drawArrays(g.TRIANGLES, 0, 6);
        shapeRange(rects, camera);
        if (lineCount) {
          use(lineProgram, camera);
          g.bindVertexArray(lineVao);
          g.drawArrays(g.TRIANGLES, 0, lineCount);
        }
        shapeRange(cards, camera); shapeRange(selection, camera); shapeRange(dots, camera); shapeRange(quads, camera);
        g.bindVertexArray(null);
      },
      timeGpu(frames) {
        if (timing) return timing;
        if (dead || contextLost || !last || !Number.isFinite(frames) || frames < 1) return Promise.resolve([]);
        const count = Math.floor(frames);
        timing = new Promise<number[]>((resolve) => {
          const results: number[] = [];
          let raf = 0, query: WebGLQuery | null = null, queryStart = 0;
          const done = () => {
            cancelAnimationFrame(raf);
            if (query) { g.deleteQuery(query); queries.delete(query); query = null; }
            stopTiming = null;
            resolve(results);
          };
          stopTiming = done;
          function step() {
            if (dead || contextLost || !last) { done(); return; }
            if (query && extension) {
              if (g.getParameter(extension.GPU_DISJOINT_EXT)) { results.push(Infinity); done(); return; }
              if (!g.getQueryParameter(query, g.QUERY_RESULT_AVAILABLE)) {
                if (performance.now() - queryStart > 1000) { results.push(Infinity); done(); return; }
                raf = requestAnimationFrame(step);
                return;
              }
              results.push(Number(g.getQueryParameter(query, g.QUERY_RESULT)) / 1e6);
              g.deleteQuery(query); queries.delete(query); query = null;
            }
            if (results.length >= count) { done(); return; }
            if (extension) query = g.createQuery();
            if (query && extension) {
              queries.add(query);
              queryStart = performance.now();
              g.beginQuery(extension.TIME_ELAPSED_EXT, query);
              renderer.draw(last.camera, last.lookup);
              g.endQuery(extension.TIME_ELAPSED_EXT);
              g.flush();
            } else {
              g.finish();
              const start = performance.now();
              renderer.draw(last.camera, last.lookup);
              g.finish();
              results.push(performance.now() - start);
            }
            raf = requestAnimationFrame(step);
          }
          raf = requestAnimationFrame(step);
        }).finally(() => { timing = null; });
        return timing;
      },
      textureBytes: () => [...textures.values()].reduce((bytes, t) => bytes + t.size * t.size * 4, 0),
      lost: () => contextLost,
      destroy() {
        if (dead) return;
        dead = true;
        canvas.removeEventListener("webglcontextlost", onLost);
        cleanup();
      },
    };
    canvas.addEventListener("webglcontextlost", onLost);
    return renderer;
  } catch {
    cleanup();
    return null;
  }
}
