import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  FlipHorizontal2,
  FlipVertical2,
  Maximize2,
  Minimize2,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { AssetListItem } from "../types";

export interface TransformedAssetInfo {
  id: number;
  width: number;
  height: number;
  file_size: number;
  thumb_url: string;
  media_url: string;
}

interface Props {
  items: AssetListItem[];
  currentIndex: number;
  onChangeIndex: (idx: number) => void;
  onClose: () => void;
  onAssetTransformed?: (info: TransformedAssetInfo) => void;
  onOpenRefCompare?: (item: AssetListItem) => void;
}

interface ViewState {
  natW: number;
  natH: number;
  fitScale: number;
  curScale: number;
  curTx: number;
  curTy: number;
  targetScale: number;
  targetTx: number;
  targetTy: number;
  // Smooth Picasa-style GPU rotation & flip animation state
  curRotDeg: number;
  targetRotDeg: number;
  curFlipX: number;
  targetFlipX: number;
  curFlipY: number;
  targetFlipY: number;
  // Anchor-locked log-space zoom physics (zero pixel drift during glide!)
  anchorActive: boolean;
  anchorDx: number;
  anchorDy: number;
  anchorImgX: number;
  anchorImgY: number;
  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  dragBaseTx: number;
  dragBaseTy: number;
  lastFrameTs: number;
  ready: boolean;
}

const VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec2 a_uv;
uniform vec2 u_viewport;
uniform vec2 u_imgSize;
uniform vec2 u_translate;
uniform float u_scale;
uniform float u_rot;
uniform float u_flipX;
uniform float u_flipY;
out vec2 v_uv;
void main() {
  vec2 p = a_pos * u_imgSize;
  p.x *= u_flipX;
  p.y *= u_flipY;
  float c = cos(u_rot);
  float s = sin(u_rot);
  vec2 rotated = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  vec2 scaled = rotated * u_scale;
  vec2 px = scaled + vec2(u_translate.x, -u_translate.y);
  vec2 clip = (px / (u_viewport * 0.5));
  // Subtle Picasa-like 3D perspective depth during horizontal/vertical flip (zero distortion at rest)
  float sinX = sqrt(max(0.0, 1.0 - u_flipX * u_flipX));
  float sinY = sqrt(max(0.0, 1.0 - u_flipY * u_flipY));
  float w = 1.0 + 0.14 * (a_pos.x * sinX + a_pos.y * sinY);
  gl_Position = vec4(clip, 0.0, w);
  v_uv = a_uv;
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}`;

interface GLRenderer {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  tex: WebGLTexture;
  vao: WebGLVertexArrayObject;
  uViewport: WebGLUniformLocation | null;
  uImgSize: WebGLUniformLocation | null;
  uTranslate: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uRot: WebGLUniformLocation | null;
  uFlipX: WebGLUniformLocation | null;
  uFlipY: WebGLUniformLocation | null;
}

function initWebGL2(canvas: HTMLCanvasElement): GLRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  // Quad centered at (0,0) from -0.5..0.5
  const verts = new Float32Array([
    -0.5, -0.5, 0, 1,
     0.5, -0.5, 1, 1,
    -0.5,  0.5, 0, 0,
     0.5,  0.5, 1, 0,
  ]);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(program, "a_pos");
  const aUv = gl.getAttribLocation(program, "a_uv");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  return {
    gl,
    program,
    tex,
    vao,
    uViewport: gl.getUniformLocation(program, "u_viewport"),
    uImgSize: gl.getUniformLocation(program, "u_imgSize"),
    uTranslate: gl.getUniformLocation(program, "u_translate"),
    uScale: gl.getUniformLocation(program, "u_scale"),
    uRot: gl.getUniformLocation(program, "u_rot"),
    uFlipX: gl.getUniformLocation(program, "u_flipX"),
    uFlipY: gl.getUniformLocation(program, "u_flipY"),
  };
}

export const LightboxModal: React.FC<Props> = ({ items, currentIndex, onChangeIndex, onClose, onAssetTransformed, onOpenRefCompare }) => {
  const { t } = useI18n();
  const item = items[currentIndex];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<GLRenderer | null>(null);
  const fallbackImgRef = useRef<ImageBitmap | HTMLImageElement | null>(null);
  const pctBadgeRef = useRef<HTMLSpanElement | null>(null);
  const dimTextRef = useRef<HTMLSpanElement | null>(null);

  const [isZoomedUI, setIsZoomedUI] = useState(false);
  const [loadingImg, setLoadingImg] = useState(false);
  const [transformState, setTransformState] = useState<{ rotCw: number; flipH: boolean }>({ rotCw: 0, flipH: false });
  const transformRef = useRef<{ assetId: number | null; rotCw: number; flipH: boolean }>({
    assetId: item?.id ?? null,
    rotCw: 0,
    flipH: false,
  });

  const stRef = useRef<ViewState>({
    natW: item?.width || 1024,
    natH: item?.height || 1024,
    fitScale: 1,
    curScale: 1,
    curTx: 0,
    curTy: 0,
    targetScale: 1,
    targetTx: 0,
    targetTy: 0,
    curRotDeg: 0,
    targetRotDeg: 0,
    curFlipX: 1,
    targetFlipX: 1,
    curFlipY: 1,
    targetFlipY: 1,
    anchorActive: false,
    anchorDx: 0,
    anchorDy: 0,
    anchorImgX: 0,
    anchorImgY: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragBaseTx: 0,
    dragBaseTy: 0,
    lastFrameTs: 0,
    ready: false,
  });

  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("comfyvault:pause-bg-videos"));
  }, [item?.id]);

  const computeFitScale = (w: number, h: number) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return Math.min((vw * 0.92) / Math.max(1, w), (vh * 0.88) / Math.max(1, h), 1);
  };

  const getEffectiveSize = (natW: number, natH: number) => {
    const swap = transformRef.current.rotCw % 180 === 90;
    return { effW: swap ? natH : natW, effH: swap ? natW : natH };
  };

  const clampPan = (tx: number, ty: number, scale: number, natW: number, natH: number) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { effW, effH } = getEffectiveSize(natW, natH);
    const scaledW = effW * scale;
    const scaledH = effH * scale;
    const maxX = Math.max(0, (scaledW - vw) / 2 + 48);
    const maxY = Math.max(0, (scaledH - vh) / 2 + 48);
    return {
      x: Math.max(-maxX, Math.min(maxX, tx)),
      y: Math.max(-maxY, Math.min(maxY, ty)),
    };
  };

  const drawFrame = useCallback(() => {
    const st = stRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !st.ready) return;

    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const targetW = Math.round(vw * dpr);
    const targetH = Math.round(vh * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const r = glRef.current;
    if (r) {
      const { gl } = r;
      gl.viewport(0, 0, targetW, targetH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(r.program);
      gl.bindVertexArray(r.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, r.tex);
      gl.uniform2f(r.uViewport, vw, vh);
      gl.uniform2f(r.uImgSize, st.natW, st.natH);
      gl.uniform2f(r.uTranslate, st.curTx, st.curTy);
      gl.uniform1f(r.uScale, st.curScale);
      gl.uniform1f(r.uRot, (-st.curRotDeg * Math.PI) / 180);
      gl.uniform1f(r.uFlipX, st.curFlipX);
      gl.uniform1f(r.uFlipY, st.curFlipY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (fallbackImgRef.current) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, vw, vh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.save();
        ctx.translate(vw / 2 + st.curTx, vh / 2 + st.curTy);
        ctx.rotate((st.curRotDeg * Math.PI) / 180);
        ctx.scale(st.curScale * st.curFlipX, st.curScale * st.curFlipY);
        ctx.drawImage(fallbackImgRef.current, -st.natW / 2, -st.natH / 2, st.natW, st.natH);
        ctx.restore();
      }
    }

    const canDrag = st.curScale > st.fitScale + 0.006;
    canvas.style.cursor = st.dragging ? "grabbing" : canDrag ? "grab" : "zoom-in";
    if (pctBadgeRef.current) {
      pctBadgeRef.current.textContent = `${Math.round(st.curScale * 100)}%`;
    }
  }, []);

  const syncZoomedFlag = useCallback(() => {
    const st = stRef.current;
    const z = st.targetScale > st.fitScale + 0.008;
    setIsZoomedUI((prev) => (prev === z ? prev : z));
  }, []);

  // Locked 60-144Hz GPU rAF log-space spring-damping loop (true Picasa liquid zoom)
  const ensureLoop = useCallback(() => {
    if (rafIdRef.current !== null) return;
    stRef.current.lastFrameTs = performance.now();

    const step = (now: number) => {
      const st = stRef.current;
      const dt = Math.min(0.05, Math.max(0.001, (now - st.lastFrameTs) / 1000));
      st.lastFrameTs = now;

      // Silky Picasa logarithmic exponential damping
      const alpha = 1 - Math.exp(-11.5 * dt);
      const tAlpha = 1 - Math.exp(-13.5 * dt);

      const curLog = Math.log(Math.max(0.01, st.curScale));
      const targetLog = Math.log(Math.max(0.01, st.targetScale));
      const dLog = targetLog - curLog;
      const dTx = st.targetTx - st.curTx;
      const dTy = st.targetTy - st.curTy;
      const dRot = st.targetRotDeg - st.curRotDeg;
      const dFx = st.targetFlipX - st.curFlipX;
      const dFy = st.targetFlipY - st.curFlipY;

      const settled =
        Math.abs(dLog) < 0.0004 &&
        Math.abs(dTx) < 0.12 &&
        Math.abs(dTy) < 0.12 &&
        Math.abs(dRot) < 0.08 &&
        Math.abs(dFx) < 0.002 &&
        Math.abs(dFy) < 0.002;

      if (settled || st.dragging) {
        st.curScale = st.targetScale;
        st.curTx = st.targetTx;
        st.curTy = st.targetTy;
        if (!st.dragging) {
          st.curRotDeg = st.targetRotDeg;
          st.curFlipX = st.targetFlipX;
          st.curFlipY = st.targetFlipY;
        }
        st.anchorActive = false;
        drawFrame();
        rafIdRef.current = null;
        return;
      }

      const nextScale = Math.exp(curLog + dLog * alpha);
      st.curScale = nextScale;
      st.curRotDeg += dRot * tAlpha;
      st.curFlipX += dFx * tAlpha;
      st.curFlipY += dFy * tAlpha;

      if (st.anchorActive) {
        // Keep exact cursor pixel locked throughout the entire glide!
        const rawTx = st.anchorDx - st.anchorImgX * nextScale;
        const rawTy = st.anchorDy - st.anchorImgY * nextScale;
        const clamped = clampPan(rawTx, rawTy, nextScale, st.natW, st.natH);
        st.curTx = clamped.x;
        st.curTy = clamped.y;
      } else {
        st.curTx += dTx * alpha;
        st.curTy += dTy * alpha;
      }

      drawFrame();
      rafIdRef.current = window.requestAnimationFrame(step);
    };

    rafIdRef.current = window.requestAnimationFrame(step);
  }, [drawFrame]);

  const animateToFit = useCallback(() => {
    const st = stRef.current;
    st.anchorActive = false;
    st.targetScale = st.fitScale;
    st.targetTx = 0;
    st.targetTy = 0;
    syncZoomedFlag();
    ensureLoop();
  }, [ensureLoop, syncZoomedFlag]);

  const zoomAtPoint = useCallback(
    (clientX: number, clientY: number, nextScale: number) => {
      const st = stRef.current;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dx = clientX - vw / 2;
      const dy = clientY - vh / 2;

      // Anchor from current rendered state so cursor pixel stays rock-solid with zero jump
      const imgX = (dx - st.curTx) / st.curScale;
      const imgY = (dy - st.curTy) / st.curScale;

      const rawTx = dx - imgX * nextScale;
      const rawTy = dy - imgY * nextScale;
      const clamped = clampPan(rawTx, rawTy, nextScale, st.natW, st.natH);

      st.anchorActive = true;
      st.anchorDx = dx;
      st.anchorDy = dy;
      st.anchorImgX = imgX;
      st.anchorImgY = imgY;
      st.targetScale = nextScale;
      st.targetTx = clamped.x;
      st.targetTy = clamped.y;
      syncZoomedFlag();
      ensureLoop();
    },
    [ensureLoop, syncZoomedFlag]
  );

  // Initialize WebGL2 once when image canvas mounts
  useEffect(() => {
    if (!item || item.media_type !== "image") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!glRef.current) {
      glRef.current = initWebGL2(canvas);
    }
  }, [item?.media_type]);

  // Commit pending rotation/flip to backend when leaving current image (switch or close)
  const commitTransformIfDirty = useCallback(() => {
    const cur = transformRef.current;
    if (!cur.assetId || (cur.rotCw === 0 && !cur.flipH)) return;
    const { assetId, rotCw, flipH } = cur;
    transformRef.current = { assetId, rotCw: 0, flipH: false };
    setTransformState({ rotCw: 0, flipH: false });
    api
      .transformAsset(assetId, rotCw, flipH)
      .then((res) => {
        if (res.ok && !res.unchanged && res.id && res.width && res.height && res.thumb_url && res.media_url) {
          onAssetTransformed?.({
            id: res.id,
            width: res.width,
            height: res.height,
            file_size: res.file_size || 0,
            thumb_url: res.thumb_url,
            media_url: res.media_url,
          });
        }
      })
      .catch(() => {
        // silently ignore or handled via reload
      });
  }, [onAssetTransformed]);

  const handleCloseSafe = useCallback(() => {
    commitTransformIfDirty();
    onClose();
  }, [commitTransformIfDirty, onClose]);

  const handleChangeIndexSafe = useCallback(
    (idx: number) => {
      commitTransformIfDirty();
      onChangeIndex(idx);
    },
    [commitTransformIfDirty, onChangeIndex]
  );

  const applyTransformOp = useCallback(
    (op: "rot_ccw" | "rot_cw" | "flip_h" | "flip_v") => {
      if (!item || item.media_type !== "image" || !stRef.current.ready) return;
      const cur = transformRef.current;
      const st = stRef.current;

      // 1. Update canonical D4 state for exact lossless backend save
      let nextRot = cur.rotCw;
      let nextFlip = cur.flipH;
      if (op === "rot_cw") {
        nextRot = (cur.rotCw + 90) % 360;
        st.targetRotDeg += 90;
      } else if (op === "rot_ccw") {
        nextRot = (cur.rotCw + 270) % 360;
        st.targetRotDeg -= 90;
      } else if (op === "flip_h") {
        nextRot = (360 - cur.rotCw) % 360;
        nextFlip = !cur.flipH;
        const rotMod = ((Math.round(st.targetRotDeg) % 180) + 180) % 180;
        if (rotMod === 90) st.targetFlipY = -st.targetFlipY;
        else st.targetFlipX = -st.targetFlipX;
      } else if (op === "flip_v") {
        nextRot = (180 - cur.rotCw + 360) % 360;
        nextFlip = !cur.flipH;
        const rotMod = ((Math.round(st.targetRotDeg) % 180) + 180) % 180;
        if (rotMod === 90) st.targetFlipX = -st.targetFlipX;
        else st.targetFlipY = -st.targetFlipY;
      }
      transformRef.current = { assetId: item.id, rotCw: nextRot, flipH: nextFlip };
      setTransformState({ rotCw: nextRot, flipH: nextFlip });

      // 2. Smoothly glide scale & pan to fit the newly oriented dimensions (Picasa style!)
      const { effW, effH } = getEffectiveSize(st.natW, st.natH);
      const nextFit = computeFitScale(effW, effH);
      st.fitScale = nextFit;
      st.targetScale = nextFit;
      st.targetTx = 0;
      st.targetTy = 0;
      st.anchorActive = false;
      if (dimTextRef.current) dimTextRef.current.textContent = `${effW} × ${effH}`;
      syncZoomedFlag();
      ensureLoop();
    },
    [item, ensureLoop, syncZoomedFlag]
  );

  // Upload image ONCE to GPU texture with hardware trilinear mipmaps
  useEffect(() => {
    if (!item || item.media_type !== "image") return;
    let cancelled = false;
    setLoadingImg(true);
    stRef.current.ready = false;
    stRef.current.curRotDeg = 0;
    stRef.current.targetRotDeg = 0;
    stRef.current.curFlipX = 1;
    stRef.current.targetFlipX = 1;
    stRef.current.curFlipY = 1;
    stRef.current.targetFlipY = 1;
    transformRef.current = { assetId: item.id, rotCw: 0, flipH: false };
    setTransformState({ rotCw: 0, flipH: false });

    const load = async () => {
      try {
        const resp = await fetch(item.media_url);
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);
        if (cancelled) {
          bmp.close();
          return;
        }
        const w = bmp.width;
        const h = bmp.height;

        const r = glRef.current;
        if (r) {
          const { gl } = r;
          gl.bindTexture(gl.TEXTURE_2D, r.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
          gl.generateMipmap(gl.TEXTURE_2D);
          bmp.close();
        } else {
          if (fallbackImgRef.current && "close" in fallbackImgRef.current) {
            (fallbackImgRef.current as ImageBitmap).close();
          }
          fallbackImgRef.current = bmp;
        }

        const fs = computeFitScale(w, h);
        const st = stRef.current;
        st.natW = w;
        st.natH = h;
        st.fitScale = fs;
        st.curScale = fs;
        st.targetScale = fs;
        st.curTx = 0;
        st.curTy = 0;
        st.targetTx = 0;
        st.targetTy = 0;
        st.ready = true;
        if (dimTextRef.current) dimTextRef.current.textContent = `${w} × ${h}`;
        syncZoomedFlag();
        setLoadingImg(false);
        drawFrame();
      } catch {
        if (!cancelled) setLoadingImg(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.media_url, item?.media_type, drawFrame, syncZoomedFlag]);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) window.cancelAnimationFrame(rafIdRef.current);
      if (fallbackImgRef.current && "close" in fallbackImgRef.current) {
        (fallbackImgRef.current as ImageBitmap).close();
      }
    };
  }, []);

  // Handle window resize
  useEffect(() => {
    const onResize = () => {
      const st = stRef.current;
      if (!st.ready) return;
      const prevFit = st.fitScale;
      const nextFit = computeFitScale(st.natW, st.natH);
      st.fitScale = nextFit;
      if (st.targetScale <= prevFit + 0.008) {
        st.curScale = nextFit;
        st.targetScale = nextFit;
        st.curTx = 0;
        st.curTy = 0;
        st.targetTx = 0;
        st.targetTy = 0;
      }
      drawFrame();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawFrame]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleCloseSafe();
      } else if (e.key === "ArrowLeft" && currentIndex > 0) {
        e.preventDefault();
        handleChangeIndexSafe(currentIndex - 1);
      } else if (e.key === "ArrowRight" && currentIndex < items.length - 1) {
        e.preventDefault();
        handleChangeIndexSafe(currentIndex + 1);
      } else if (item?.media_type === "image") {
        const k = e.key.toLowerCase();
        if (k === "q" || e.key === "[") {
          e.preventDefault();
          applyTransformOp("rot_ccw");
        } else if (k === "e" || e.key === "]") {
          e.preventDefault();
          applyTransformOp("rot_cw");
        } else if (k === "h") {
          e.preventDefault();
          applyTransformOp("flip_h");
        } else if (k === "v") {
          e.preventDefault();
          applyTransformOp("flip_v");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handleCloseSafe, handleChangeIndexSafe, applyTransformOp, currentIndex, items.length, item?.media_type]);

  // Non-passive wheel zoom (silky exponential up to 400%)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!item || item.media_type !== "image" || !stRef.current.ready) return;
      e.preventDefault();
      e.stopPropagation();

      const st = stRef.current;
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 32;
      else if (e.deltaMode === 2) delta *= 400;
      delta = Math.max(-240, Math.min(240, delta));

      // Fine Picasa-grade granularity (~11% per mouse notch; fast spins accumulate smoothly up to 400%)
      const zoomFactor = Math.exp(-delta * 0.0011);
      const minScale = Math.min(st.fitScale * 0.5, 0.1);
      const nextScale = Math.max(minScale, Math.min(4.0, st.targetScale * zoomFactor));

      if (delta > 0 && st.targetScale > st.fitScale && nextScale <= st.fitScale * 1.03) {
        animateToFit();
        return;
      }

      zoomAtPoint(e.clientX, e.clientY, nextScale);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [item, animateToFit, zoomAtPoint]);

  // 120fps direct WebGL2 panning
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = stRef.current;
      if (!st.dragging) return;
      const dx = e.clientX - st.dragStartX;
      const dy = e.clientY - st.dragStartY;
      const clamped = clampPan(st.dragBaseTx + dx, st.dragBaseTy + dy, st.curScale, st.natW, st.natH);
      st.curTx = clamped.x;
      st.curTy = clamped.y;
      st.targetTx = clamped.x;
      st.targetTy = clamped.y;
      drawFrame();
    };
    const onUp = () => {
      const st = stRef.current;
      if (!st.dragging) return;
      st.dragging = false;
      drawFrame();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drawFrame]);

  // Helper: check if click landed inside the rendered image bounds
  const isPointInsideImage = (clientX: number, clientY: number) => {
    const st = stRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { effW, effH } = getEffectiveSize(st.natW, st.natH);
    const halfW = (effW * st.curScale) / 2;
    const halfH = (effH * st.curScale) / 2;
    const cx = vw / 2 + st.curTx;
    const cy = vh / 2 + st.curTy;
    return Math.abs(clientX - cx) <= halfW && Math.abs(clientY - cy) <= halfH;
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !stRef.current.ready) return;
    const st = stRef.current;
    if (st.curScale <= st.fitScale + 0.008) return;
    if (!isPointInsideImage(e.clientX, e.clientY)) return;
    e.preventDefault();
    st.dragging = true;
    st.dragStartX = e.clientX;
    st.dragStartY = e.clientY;
    st.dragBaseTx = st.curTx;
    st.dragBaseTy = st.curTy;
    drawFrame();
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!stRef.current.ready) return;
    if (!isPointInsideImage(e.clientX, e.clientY)) return;
    const st = stRef.current;
    if (st.targetScale > st.fitScale + 0.008 || Math.abs(st.targetScale - 1.0) < 0.01) {
      animateToFit();
    } else {
      zoomAtPoint(e.clientX, e.clientY, 1.0);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!stRef.current.ready) return;
    if (!isPointInsideImage(e.clientX, e.clientY)) {
      handleCloseSafe();
    }
  };

  if (!item) return null;

  return (
    <div
      ref={containerRef}
      data-keep-dark="true"
      className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center overflow-hidden select-none"
    >
      {/* Top Floating HUD (no expensive full-screen backdrop-blur) */}
      <div className="fixed top-3 inset-x-4 z-20 flex items-center justify-between pointer-events-none">
        <div className="pointer-events-auto px-3.5 py-1.5 rounded-xl bg-black/80 border border-white/10 flex items-center gap-3 text-xs text-zinc-200 max-w-[65vw]">
          <span className="font-medium truncate">{item.filename}</span>
          <span ref={dimTextRef} className="text-zinc-400 font-mono shrink-0">
            {item.width} × {item.height}
          </span>
          {item.media_type === "image" && (
            <span
              ref={pctBadgeRef}
              className="px-1.5 py-0.5 rounded bg-indigo-500/25 text-indigo-200 font-mono text-[11px] shrink-0 min-w-[44px] text-center"
            >
              100%
            </span>
          )}
          <span className="text-zinc-500 text-[11px] shrink-0">
            {currentIndex + 1} / {items.length}
          </span>
          {(transformState.rotCw !== 0 || transformState.flipH) && (
            <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] font-medium shrink-0">
              {t("已翻转 · 切图或退出自动保存", "Transformed · Auto-saves on Next/Close")}
            </span>
          )}
        </div>

        <div className="pointer-events-auto flex items-center gap-1.5">
          {item.reference_image_url && onOpenRefCompare && (
            <button
              type="button"
              onClick={() => onOpenRefCompare(item)}
              className="px-2.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/50 text-amber-200 text-xs font-semibold flex items-center gap-1.5"
              title={t("分屏对比反推原图与当前生成图", "Split compare reference image vs generated output")}
            >
              <Columns2 className="w-4 h-4 text-amber-300" />
              {t("分屏对比原图", "Compare Ref")}
            </button>
          )}
          {item.media_type === "image" && (
            <>
              {/* Rotate & Flip Controls */}
              <div className="flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-black/80 border border-white/10">
                <button
                  type="button"
                  title={t("向左旋转 90° (Q)", "Rotate Left 90° (Q)")}
                  onClick={() => applyTransformOp("rot_ccw")}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title={t("向右旋转 90° (E)", "Rotate Right 90° (E)")}
                  onClick={() => applyTransformOp("rot_cw")}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white"
                >
                  <RotateCw className="w-4 h-4" />
                </button>
                <div className="w-px h-4 bg-white/15 mx-0.5" />
                <button
                  type="button"
                  title={t("水平镜像翻转 (H)", "Flip Horizontal (H)")}
                  onClick={() => applyTransformOp("flip_h")}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white"
                >
                  <FlipHorizontal2 className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title={t("垂直镜像翻转 (V)", "Flip Vertical (V)")}
                  onClick={() => applyTransformOp("flip_v")}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white"
                >
                  <FlipVertical2 className="w-4 h-4" />
                </button>
              </div>

              {/* Zoom Controls */}
              <div className="flex items-center gap-1 px-1.5 py-1 rounded-xl bg-black/80 border border-white/10">
                <button
                  type="button"
                  title={t("缩小", "Zoom Out")}
                  onClick={() => {
                    const st = stRef.current;
                    const ns = Math.max(Math.min(st.fitScale * 0.5, 0.1), st.targetScale / 1.35);
                    if (ns <= st.fitScale * 1.04) animateToFit();
                    else zoomAtPoint(window.innerWidth / 2, window.innerHeight / 2, ns);
                  }}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title={isZoomedUI ? t("适应窗口 (双击图片)", "Fit to Window (Double-click)") : t("放大到 100% (双击图片)", "Zoom to 100% (Double-click)")}
                  onClick={() => {
                    if (isZoomedUI) animateToFit();
                    else zoomAtPoint(window.innerWidth / 2, window.innerHeight / 2, 1.0);
                  }}
                  className="px-2 py-1 rounded-lg hover:bg-white/10 text-xs font-mono text-zinc-200 flex items-center gap-1"
                >
                  {isZoomedUI ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                  {isZoomedUI ? t("适应", "Fit") : "100%"}
                </button>
                <button
                  type="button"
                  title={t("放大 (最大 400%)", "Zoom In (max 400%)")}
                  onClick={() => {
                    const st = stRef.current;
                    const ns = Math.min(4.0, st.targetScale * 1.35);
                    zoomAtPoint(window.innerWidth / 2, window.innerHeight / 2, ns);
                  }}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
              </div>
            </>
          )}

          <button
            type="button"
            onClick={handleCloseSafe}
            title={t("关闭 (Esc)", "Close (Esc)")}
            className="p-2 rounded-xl bg-black/80 hover:bg-rose-600/80 border border-white/15 text-zinc-200 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Left / Right Navigation Arrows */}
      {currentIndex > 0 && (
        <button
          type="button"
          onClick={() => handleChangeIndexSafe(currentIndex - 1)}
          title={t("上一张 (←)", "Previous (←)")}
          className="fixed left-4 top-1/2 -translate-y-1/2 z-20 p-2.5 rounded-full bg-black/70 hover:bg-black/90 border border-white/15 text-zinc-200 hover:text-white transition-colors"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}
      {currentIndex < items.length - 1 && (
        <button
          type="button"
          onClick={() => handleChangeIndexSafe(currentIndex + 1)}
          title={t("下一张 (→)", "Next (→)")}
          className="fixed right-4 top-1/2 -translate-y-1/2 z-20 p-2.5 rounded-full bg-black/70 hover:bg-black/90 border border-white/15 text-zinc-200 hover:text-white transition-colors"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}

      {/* Main Media: WebGL2 GPU Canvas for Images / Native Video for Videos */}
      {item.media_type === "video" ? (
        <video
          key={item.id}
          src={item.media_url}
          controls
          autoPlay
          loop
          className="max-w-[92vw] max-h-[86vh] rounded-lg shadow-2xl"
        />
      ) : (
        <>
          <canvas
            ref={canvasRef}
            onMouseDown={handleCanvasMouseDown}
            onDoubleClick={handleCanvasDoubleClick}
            onClick={handleCanvasClick}
            className="w-screen h-screen block"
          />
          {loadingImg && (
            <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
              <div className="px-4 py-2 rounded-xl bg-black/80 border border-white/10 text-xs text-zinc-300">
                {t("加载原图纹理中...", "Loading full-resolution texture...")}
              </div>
            </div>
          )}
        </>
      )}

      {/* Bottom hint */}
      {item.media_type === "image" && (
        <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-black/75 border border-white/10 text-[11px] text-zinc-400 pointer-events-none">
          {t(
            "WebGL2 硬件加速 · 滚轮缩放 · 双击 100%/适应 · Q/E 旋转 · H/V 镜像 (切图或关闭自动保存) · ←/→ 切图 · Esc 关闭",
            "WebGL2 GPU · Wheel Zoom · Double-click 100%/Fit · Q/E Rotate · H/V Flip (Auto-saves on Next/Close) · ←/→ Nav · Esc Close"
          )}
        </div>
      )}
    </div>
  );
};
