import type { AtlasRegion, AtlasUploader, CardAtlas } from "./cardAtlas";

export type GpuColor = [number, number, number, number];
export interface GpuCamera { z: number; x: number; y: number; dpr: number; width: number; height: number }
export interface GpuCardInstance { id: string; x: number; y: number; w: number; h: number; radius: number; border: GpuColor; borderWidth: number; hidden: boolean; z: number }
// 굵기·대시·점 반지름은 월드 단위다 — DOM 의 연결선 SVG·끝 점이 카메라 층 안에 있어 배율에 따라 같이 굵어지고 가늘어진다.
//  화면에서 1px 보다 가늘어지면 1px 로 그리고 그만큼 옅게(브라우저가 가는 SVG 선을 옅게 그리는 것과 같은 인상).
export interface GpuLine { points: Float32Array; color: GpuColor; width: number; dash: number; gap?: number }
export interface GpuRect { x: number; y: number; w: number; h: number; radius: number; fill: GpuColor; border: GpuColor; borderWidth: number; owner?: string; hideLow?: boolean }
// hideLow = 25% 이하 단순화에서 숨기는 조각(GpuBoard 가 setScene 전에 거른다)
export interface GpuDot { x: number; y: number; r: number; fill: GpuColor; border: GpuColor; hideLow?: boolean }
export interface GpuQuad { id: string; x: number; y: number; w: number; h: number; hideLow?: boolean; owner?: string }
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
  /** 25% 이하 단순화 — hideLow 조각(결과 수 배지·폴더 이름표·회색 끝 점)을 그리지 않는다(유니폼 하나 — 버퍼 그대로) */
  setLowLod(on: boolean): void;
  draw(camera: GpuCamera, lookup: CardAtlas["lookup"]): void;
  /** 정확히 frames개의 유한한 표본을 반환하며 중단·무효 표본이면 거부한다. */
  timeGpu(frames: number): Promise<number[]>;
  textureBytes(): number;
  texturePeak(): number;
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
// style.z = 25% 이하 단순화에서 숨길 조각(hideLow) — lowLod 유니폼이 켜지면 그 조각을 화면 밖으로 보낸다(버퍼를 다시 채우지 않는다)
const shapeVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 unit;
layout(location=1) in vec4 box;
layout(location=2) in vec3 style;
layout(location=3) in vec4 fill;
layout(location=4) in vec4 border;
layout(location=5) in vec4 uv;
layout(location=6) in float textureIndex;
${cameraUniforms}
uniform bool lowLod;
out vec2 local; out vec2 texCoord;
flat out vec2 extent; flat out vec2 edge;
flat out vec4 fillColor; flat out vec4 borderColor;
flat out highp int textureSlot;
void main() {
  extent = box.zw * camera.x;
  local = unit * extent;
  edge = style.xy * camera.x;
  vec2 p = box.xy * camera.x + camera.yz + local;
  gl_Position = lowLod && style.z > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0, 0, 1);
  texCoord = mix(uv.xy, uv.zw, unit);
  fillColor = fill; borderColor = border;
  textureSlot = int(textureIndex);
}`;
const shapeFragment = `#version 300 es
precision highp float;
uniform sampler2D atlas[8];
in vec2 local; in vec2 texCoord;
flat in vec2 extent; flat in vec2 edge;
flat in vec4 fillColor; flat in vec4 borderColor;
flat in highp int textureSlot;
out vec4 outColor;
void main() {
  float r = min(edge.x, min(extent.x, extent.y) * 0.5);
  vec2 q = abs(local - extent * 0.5) - extent * 0.5 + r;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float aa = max(fwidth(distance), 0.001);
  float coverage = 1.0 - smoothstep(-aa, 0.0, distance);
  vec4 c = fillColor;
  ${Array.from({ length: 8 }, (_, i) => `${i ? "else " : ""}if (textureSlot == ${i}) c = texture(atlas[${i}], texCoord);`).join("\n  ")}
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
type Batch = Range & { pages: number[] };
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
  const textures = new Map<number, { value: WebGLTexture; width: number; height: number }>();
  let texturePeakBytes = 0;
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

  function releaseContext() {
    canvas.removeEventListener("webglcontextlost", onLost);
    g.getExtension("WEBGL_lose_context")?.loseContext();
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
    const cardRanges = new Map<string, Range>();
    let hiddenId: string | null = null;
    let lowLod = false;
    let rects: Range = { start: 0, count: 0 }, cards = rects, dots = rects;
    const batches = new Map<Range, Batch[]>();
    let batchesDirty = true;
    let lineCount = 0;
    let gridColor: GpuColor = [1, 1, 1, 0.11];
    const extension = g.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExtension | null;

    function shapeRange(range: Range, camera: GpuCamera) {
      if (!range.count) return;
      use(shapeProgram, camera);
      g.bindVertexArray(shapeVao);
      g.uniform1iv(uniform(shapeProgram, "atlas[0]"), [0, 1, 2, 3, 4, 5, 6, 7]);
      g.uniform1i(uniform(shapeProgram, "lowLod"), lowLod ? 1 : 0);
      for (const { start, count, pages } of batches.get(range) ?? []) {
        g.bindBuffer(g.ARRAY_BUFFER, shapeBuffer);
        attribute(1, 4, 15, start * 15, 1);
        attribute(2, 3, 15, start * 15 + 4, 1);
        attribute(3, 4, 15, start * 15 + 7, 1);
        attribute(4, 4, 15, start * 15 + 11, 1);
        g.bindBuffer(g.ARRAY_BUFFER, uvBuffer);
        attribute(5, 4, 5, start * 5, 1);
        attribute(6, 1, 5, start * 5 + 4, 1);
        pages.forEach((page, i) => {
          g.activeTexture(g.TEXTURE0 + i);
          g.bindTexture(g.TEXTURE_2D, textures.get(page)!.value);
        });
        g.drawArraysInstanced(g.TRIANGLES, 0, 6, count);
      }
    }

    const renderer: GpuRenderer = {
      ensurePage(page, width, height = width) {
        if (dead || contextLost) return;
        const old = textures.get(page);
        if (old) { if (old.width !== width || old.height !== height) throw new Error("Atlas page size changed"); return; }
        if ([width, height].some((size) => !Number.isInteger(size) || size < 1 || size > g.getParameter(g.MAX_TEXTURE_SIZE))) throw new RangeError("GPU texture size unsupported");
        const bytes = renderer.textureBytes() + width * height * 4;
        if (bytes > 128 * 1024 * 1024) throw new RangeError("GPU texture budget exhausted");
        const t = g.createTexture();
        if (!t) throw new Error("GPU texture unavailable");
        try {
          g.bindTexture(g.TEXTURE_2D, t);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
          g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
          g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA8, width, height);
          if (g.getError() !== g.NO_ERROR) throw new Error("GPU texture allocation failed");
          textures.set(page, { value: t, width, height });
          texturePeakBytes = Math.max(texturePeakBytes, bytes);
          batchesDirty = true;
        } catch (error) { g.deleteTexture(t); throw error; }
      },
      upload(page, x, y, source, w, h) {
        if (dead || contextLost) return;
        const t = textures.get(page);
        if (!t || x < 0 || y < 0 || w < 1 || h < 1 || x + w > t.width || y + h > t.height || source.width !== w || source.height !== h) throw new RangeError("Invalid atlas upload");
        g.bindTexture(g.TEXTURE_2D, t.value);
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
        g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        // 올릴 때마다 getError 로 묻지 않는다 — GPU 와 동기화해 멈춰 서서 2,060장 실측에서 프로파일 931ms 였다(11-11). 장 할당(texStorage2D)만 묻는다.
        g.texSubImage2D(g.TEXTURE_2D, 0, x, y, g.RGBA, g.UNSIGNED_BYTE, source);
      },
      deletePage(page) {
        const t = textures.get(page);
        if (t) { g.deleteTexture(t.value); textures.delete(page); batchesDirty = true; }
      },
      setScene(s) {
        if (dead || contextLost) return;
        const data: number[] = [];
        shapes = [];
        function add(r: GpuRect, id?: string, hideLow = false) {
          data.push(r.x, r.y, r.w, r.h, r.radius, r.borderWidth, Number(hideLow), ...r.fill, ...r.border);
          shapes.push({ id, page: -1, region: null });
        }
        function range(build: () => void): Range {
          const start = shapes.length;
          build();
          return { start, count: shapes.length - start };
        }
        const ownedRects = new Map<string, GpuRect[]>(), ownedQuads = new Map<string, GpuQuad[]>();
        function addQuad(q: GpuQuad) {
          add({ ...q, radius: 0, borderWidth: 0, fill: transparent, border: transparent }, q.id, !!q.hideLow);
        }
        rects = range(() => {
          for (const r of [...s.rects, ...(s.selection ?? [])]) {
            if (r.owner === undefined) add(r, undefined, !!r.hideLow);
            else { const list = ownedRects.get(r.owner) ?? []; list.push(r); ownedRects.set(r.owner, list); }
          }
          for (const q of s.quads) {
            if (q.owner === undefined) addQuad(q);
            else { const list = ownedQuads.get(q.owner) ?? []; list.push(q); ownedQuads.set(q.owner, list); }
          }
        });
        cardRanges.clear();
        cards = range(() => s.cards.filter((c) => !c.hidden).sort((a, b) => a.z - b.z).forEach((c) => {
          cardRanges.set(c.id, range(() => {
            add({ ...c, fill: [0.08, 0.09, 0.11, 1] }, c.id);
            ownedRects.get(c.id)?.forEach((r) => add(r, undefined, !!r.hideLow));
            ownedQuads.get(c.id)?.forEach(addQuad);
          }));
        }));
        // 끝 점(.scene-dot r=5, 테두리 2 가운데 걸침) — 월드 크기라 바깥 반지름 r+1·테두리 2
        dots = range(() => s.dots.forEach((d) => add({ x: d.x - d.r - 1, y: d.y - d.r - 1, w: d.r * 2 + 2, h: d.r * 2 + 2, radius: d.r + 1, borderWidth: 2, fill: d.fill, border: d.border }, undefined, !!d.hideLow)));
        uvs = new Float32Array(shapes.length * 5);
        shapeData = new Float32Array(data);
        hiddenId = null;
        batchesDirty = true;
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
        const next = id !== null && cardRanges.has(id) ? id : null;
        if (next === hiddenId) return;
        g.bindBuffer(g.ARRAY_BUFFER, shapeBuffer);
        // 모양 칸 = x,y,w,h,반지름,테두리,점,채움4,테두리색4 (15칸) — w·h 를 0 으로 두면 그 카드는 그려지지 않는다
        for (const [id, hide] of [[hiddenId, false], [next, true]] as const) {
          const range = id === null ? undefined : cardRanges.get(id);
          if (!range) continue;
          for (let i = range.start; i < range.start + range.count; i++) {
            g.bufferSubData(g.ARRAY_BUFFER, (i * 15 + 2) * 4, hide ? new Float32Array([0, 0]) : shapeData.subarray(i * 15 + 2, i * 15 + 4));
          }
        }
        hiddenId = next;
      },
      setLowLod(on) { lowLod = on; },
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
          if (shape.page !== (r?.page ?? -1)) batchesDirty = true;
          shape.page = r?.page ?? -1;
          uvs.set(r ? [r.u0, r.v0, r.u1, r.v1] : [0, 0, 0, 0], i * 5);
          first = Math.min(first, i); end = i + 1;
        });
        if (batchesDirty) {
          batches.clear();
          // 텍스처 장이 바뀔 때만 묶어 카드·배지·선택을 섞어도 카드마다 그리기 호출을 늘리지 않는다.
          for (const range of [rects, cards, dots]) {
            const list: Batch[] = [];
            let batch: Batch = { start: range.start, count: 0, pages: [] };
            for (let i = range.start; i < range.start + range.count; i++) {
              const page = textures.has(shapes[i].page) ? shapes[i].page : -1;
              if (page >= 0 && !batch.pages.includes(page) && batch.pages.length === 8) {
                list.push(batch); batch = { start: i, count: 0, pages: [] };
              }
              if (page >= 0 && !batch.pages.includes(page)) batch.pages.push(page);
              const slot = page < 0 ? -1 : batch.pages.indexOf(page);
              if (uvs[i * 5 + 4] !== slot) { uvs[i * 5 + 4] = slot; first = Math.min(first, i); end = Math.max(end, i + 1); }
              batch.count++;
            }
            if (batch.count) list.push(batch);
            batches.set(range, list);
          }
          batchesDirty = false;
        }
        // 새 아틀라스가 준비된 때만 UV를 바꾸고 카메라 이동은 유니폼으로 끝낸다.
        if (first < end) {
          g.bindBuffer(g.ARRAY_BUFFER, uvBuffer);
          g.bufferSubData(g.ARRAY_BUFFER, first * 20, uvs.subarray(first * 5, end * 5));
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
        shapeRange(cards, camera); shapeRange(dots, camera);
        g.bindVertexArray(null);
      },
      timeGpu(frames) {
        if (timing) return Promise.reject(new Error("GPU timing already running"));
        if (dead || contextLost || !last || !Number.isInteger(frames) || frames < 1) return Promise.reject(new Error("GPU timing unavailable"));
        timing = new Promise<number[]>((resolve, reject) => {
          const results: number[] = [];
          let raf = 0, query: WebGLQuery | null = null, queryStart = 0;
          let finished = false;
          // 무효 표본(클럭·전원 변화의 disjoint, 1초 넘게 안 끝난 질의)은 버리고 다시 잰다 — 한 번에 거부하면 무거운 씬에서 켤 때마다 잠겼다(11-11 2,060장 실측).
          //  버린 것이 요청 수를 넘거나 10초가 지나면 포기(거부 = 느린 GPU).
          let discarded = 0;
          const startedAt = performance.now();
          const done = (error?: Error) => {
            if (finished) return;
            finished = true;
            cancelAnimationFrame(raf);
            if (query) { g.deleteQuery(query); queries.delete(query); query = null; }
            stopTiming = null;
            if (error) reject(error);
            else if (results.length !== frames || results.some((ms) => !Number.isFinite(ms) || ms < 0)) reject(new Error("Invalid GPU timing samples"));
            else resolve(results);
          };
          stopTiming = () => done(new Error("GPU timing cancelled"));
          function step() {
            if (finished) return;
            if (dead || contextLost || !last) { done(new Error("GPU timing unavailable")); return; }
            try {
              if (query && extension) {
                const disjoint = !!g.getParameter(extension.GPU_DISJOINT_EXT);
                const available = !disjoint && !!g.getQueryParameter(query, g.QUERY_RESULT_AVAILABLE);
                if (!disjoint && !available && performance.now() - queryStart <= 1000) {
                  raf = requestAnimationFrame(step);
                  return;
                }
                if (available) results.push(Number(g.getQueryParameter(query, g.QUERY_RESULT)) / 1e6);
                g.deleteQuery(query); queries.delete(query); query = null;
                if (!available && (++discarded > frames || performance.now() - startedAt > 10_000)) {
                  done(new Error(disjoint ? "GPU timer disjoint" : "GPU timer timeout"));
                  return;
                }
              }
              if (results.some((ms) => !Number.isFinite(ms) || ms < 0)) { done(new Error("Invalid GPU timing samples")); return; }
              if (results.length === frames) { done(); return; }
              if (extension) query = g.createQuery();
              if (query && extension) {
                queries.add(query);
                queryStart = performance.now();
                g.beginQuery(extension.TIME_ELAPSED_EXT, query);
                try { renderer.draw(last.camera, last.lookup); }
                finally { g.endQuery(extension.TIME_ELAPSED_EXT); }
                g.flush();
              } else {
                // 타이머 확장이 없는 브라우저는 GPU 완료를 기다린 벽시계로 같은 수의 표본을 채운다.
                g.finish();
                const start = performance.now();
                renderer.draw(last.camera, last.lookup);
                g.finish();
                results.push(performance.now() - start);
              }
              raf = requestAnimationFrame(step);
            } catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
          }
          raf = requestAnimationFrame(step);
        }).finally(() => { timing = null; });
        return timing;
      },
      textureBytes: () => [...textures.values()].reduce((bytes, t) => bytes + t.width * t.height * 4, 0),
      texturePeak: () => texturePeakBytes,
      lost: () => contextLost,
      destroy() {
        if (dead) return;
        dead = true;
        canvas.removeEventListener("webglcontextlost", onLost);
        cleanup();
        releaseContext();
      },
    };
    canvas.addEventListener("webglcontextlost", onLost);
    return renderer;
  } catch {
    cleanup();
    releaseContext();
    return null;
  }
}
