/**
 * SignatureTool — Sign My Tee v1.90
 *
 * Two-step composite for the public "sign this Tee" flow:
 *
 *   1. Capture  — Upload a photo/scan OR draw freehand on a <canvas>.
 *                 Both paths funnel through `removeSignatureBackground`
 *                 so the result is a transparent-bg PNG (data URL).
 *
 *   2. Place    — Render the BG-removed PNG into the back face of the
 *                 tee at default (x: 0.7, y: 0.55). The user can then
 *                 drag, resize and rotate the signature using the
 *                 handles inside <PremiumTee> when `editable={true}`.
 *
 *   3. Save     — POST `/tee/share/:shareId/sign` with the BG-removed
 *                 dataUrl + normalized (x, y, scale, rotation). On
 *                 success we append to the local signatures array
 *                 (optimistic) and let the parent navigate away.
 *
 * v1.90 changes:
 *   - Ink colour picker (12 premium presets + custom color input)
 *   - Fixed canvas pointer sync: setPointerCapture on canvas so strokes
 *     never drift even when the cursor leaves the canvas boundary
 *   - Smooth quadratic bezier curves for nicer hand-drawn feel
 *   - Draw tab shown first by default
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { removeSignatureBackground } from '../../utils/sigRemover';
import PremiumTee, {
  type ShirtColorKey,
  type TextColorKey,
  type SignatureOverlay,
} from './PremiumTee';

type Phase = 'capture' | 'place' | 'submitting';

interface Props {
  shareId: string;
  /** v1.87.4 — accepts a named palette key or a `#rrggbb` hex
      (custom-picker tees). `PremiumTee` does the actual resolution. */
  shirtColor: ShirtColorKey | string;
  textColor: TextColorKey | string;
  /** v1.87.4 — explicit hex overrides. Win over `shirtColor` /
      `textColor` when set. Null/undefined for pre-hex tees. */
  customShirtHex?: string | null;
  customTextHex?: string | null;
  nameOnBack: string;
  existingSignatures: SignatureOverlay[];
  defaultSignerName: string;
  onCancel: () => void;
  onSigned: (next: SignatureOverlay) => void;
}

/** Premium ink colour presets */
const INK_COLORS = [
  { hex: '#1f1b16', label: 'Ink Black' },
  { hex: '#1a1a6e', label: 'Royal Blue' },
  { hex: '#0a3d62', label: 'Navy' },
  { hex: '#1e5a2b', label: 'Forest Green' },
  { hex: '#7b241c', label: 'Burgundy' },
  { hex: '#6c3483', label: 'Plum' },
  { hex: '#b7410e', label: 'Rust' },
  { hex: '#8B6914', label: 'Gold' },
  { hex: '#2c3e50', label: 'Slate' },
  { hex: '#e74c3c', label: 'Crimson' },
  { hex: '#16a085', label: 'Teal' },
  { hex: '#e67e22', label: 'Amber' },
];

export default function SignatureTool({
  shareId,
  shirtColor,
  textColor,
  customShirtHex,
  customTextHex,
  nameOnBack,
  existingSignatures,
  defaultSignerName,
  onCancel,
  onSigned,
}: Props) {
  const [phase, setPhase] = useState<Phase>('capture');
  const [signerName, setSignerName] = useState<string>(defaultSignerName);
  const [pendingSig, setPendingSig] = useState<SignatureOverlay | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Draw shown first so users can immediately sign
  const [tab, setTab] = useState<'upload' | 'draw'>('draw');
  const [inkColor, setInkColor] = useState(INK_COLORS[0].hex);
  const [hasStrokes, setHasStrokes] = useState(false);
  /** Which face the user wants to sign — front or back */
  const [signingFace, setSigningFace] = useState<'front' | 'back'>('back');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  // We accumulate ALL points of the current stroke here.
  // On moveDraw we replay the full stroke from scratch on the
  // PERSISTENT layer — this guarantees a perfectly smooth, solid
  // line without any micro-gaps between segments.
  const strokePointsRef = useRef<{ x: number; y: number }[]>([]);
  // Flattened "committed" strokes are blitted to a persistent canvas
  // so we only have to replay the CURRENT stroke on each pointer move,
  // not the entire session history.
  const persistentCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── Canvas helpers ─────────────────────────────────────────────────
  const getCtx = useCallback(() => canvasRef.current?.getContext('2d') ?? null, []);

  const initCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.max(window.devicePixelRatio ?? 1, 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const ctx = c.getContext('2d');
      if (ctx) ctx.scale(dpr, dpr);
    }
  }, []);

  const applyPenStyle = useCallback((ctx: CanvasRenderingContext2D, color: string) => {
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
  }, []);

  // Initialise canvas when draw tab mounts
  useEffect(() => {
    if (tab !== 'draw') return;
    const id = requestAnimationFrame(() => {
      initCanvas();
      const ctx = getCtx();
      if (ctx) applyPenStyle(ctx, inkColor);
    });
    return () => cancelAnimationFrame(id);
  }, [tab, initCanvas, applyPenStyle, getCtx, inkColor]);

  // Update colour style (does not redraw existing pixels)
  useEffect(() => {
    if (tab !== 'draw') return;
    const ctx = getCtx();
    if (ctx) applyPenStyle(ctx, inkColor);
  }, [inkColor, tab, applyPenStyle, getCtx]);

  // ── Canvas drawing ─────────────────────────────────────────────────
  const toCss = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Replay the current in-progress stroke cleanly on top of committed content */
  const replayStroke = useCallback((color: string) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const pts = strokePointsRef.current;
    if (pts.length < 2) return;
    // Clear only the drawing canvas (not the persistent layer — they
    // are separate canvases so we blit committed content on endDraw)
    // Since we use a single canvas here, we redraw everything each frame.
    // This is fine up to several hundred points; perf stays smooth.
    ctx.clearRect(0, 0, c.width / (window.devicePixelRatio || 1), c.height / (window.devicePixelRatio || 1));
    // Blit the committed "past strokes" pixels back
    if (persistentCanvasRef.current) {
      ctx.drawImage(persistentCanvasRef.current, 0, 0, c.clientWidth, c.clientHeight);
    }
    applyPenStyle(ctx, color);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }, [applyPenStyle]);

  const beginDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current!.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    strokePointsRef.current = [toCss(e)];
  };

  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    strokePointsRef.current.push(toCss(e));
    replayStroke(inkColor);
    setHasStrokes(true);
  };

  const endDraw = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    // Commit the current stroke to the persistent canvas so future
    // strokes don't need to re-replay it.
    const c = canvasRef.current;
    if (c) {
      if (!persistentCanvasRef.current) {
        const pc = document.createElement('canvas');
        pc.width = c.width;
        pc.height = c.height;
        persistentCanvasRef.current = pc;
      }
      const pc = persistentCanvasRef.current;
      pc.width = c.width;
      pc.height = c.height;
      const pctx = pc.getContext('2d')!;
      pctx.clearRect(0, 0, pc.width, pc.height);
      pctx.drawImage(c, 0, 0);
    }
    strokePointsRef.current = [];
  };

  const clearCanvas = () => {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    ctx.beginPath();
    persistentCanvasRef.current = null;
    strokePointsRef.current = [];
    setHasStrokes(false);
  };

  const finishDraw = () => {
    const dataUrl = canvasRef.current!.toDataURL('image/png');
    const defaultX = signingFace === 'front' ? 0.3 : 0.7;
    setPendingSig({ id: `tmp-${Date.now()}`, dataUrl, face: signingFace, x: defaultX, y: 0.55, scale: 0.6, rotation: 0 });
    setPhase('place');
  };

  // ── Upload ─────────────────────────────────────────────────────────
  const handleUpload = async (file: File) => {
    setError(null);
    try {
      const dataUrl = await removeSignatureBackground(file, { tolerance: 50 });
      const defaultX = signingFace === 'front' ? 0.3 : 0.7;
      setPendingSig({ id: `tmp-${Date.now()}`, dataUrl, face: signingFace, x: defaultX, y: 0.55, scale: 0.6, rotation: 0 });
      setPhase('place');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not process the image.');
    }
  };

  // ── Place ──────────────────────────────────────────────────────────
  const updatePending = (next: Partial<SignatureOverlay>) =>
    setPendingSig((prev) => (prev ? { ...prev, ...next } : prev));

  // ── Save ───────────────────────────────────────────────────────────
  const save = async () => {
    if (!pendingSig) return;
    if (!signerName.trim()) { setError('Add your name so the owner knows who signed.'); return; }
    setError(null);
    setPhase('submitting');
    try {
      const api = (await import('../../utils/api')).default;
      const r = await api.post(`/tee/share/${shareId}/sign`, {
        signerName: signerName.trim(),
        signerDataUrl: pendingSig.dataUrl,
        face: pendingSig.face ?? 'back',
        x: pendingSig.x, y: pendingSig.y,
        scale: pendingSig.scale, rotation: pendingSig.rotation,
      });
      const sig = r.data?.signature;
      if (!sig) throw new Error('Server did not return the saved signature.');
      onSigned({
        id: sig.id, dataUrl: sig.signerDataUrl,
        face: sig.face ?? pendingSig.face ?? 'back',
        x: sig.x ?? pendingSig.x, y: sig.y ?? pendingSig.y,
        scale: sig.scale ?? pendingSig.scale, rotation: sig.rotation ?? pendingSig.rotation,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the signature.');
      setPhase('place');
    }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-bg/95 backdrop-blur-sm overflow-y-auto">
      <div className="min-h-full flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20 }}
          className="w-full max-w-2xl bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-lg font-serif text-ink">Sign this T-shirt</h2>
              <p className="text-xs text-ink-soft">
                {phase === 'capture' && 'Draw your signature or upload a photo of it.'}
                {phase === 'place' && 'Drag, resize or rotate your signature. Then save.'}
                {phase === 'submitting' && 'Saving…'}
              </p>
            </div>
            <button type="button" onClick={onCancel}
              className="px-3 py-1 rounded-lg text-sm text-ink-soft hover:text-ink hover:bg-mist transition-colors">
              Cancel
            </button>
          </div>

          <AnimatePresence mode="wait">
            {phase === 'capture' && (
              <motion.div key="capture" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -18 }} className="p-6 space-y-4">
                {/* Face selector */}
                <div>
                  <p className="text-xs font-medium text-ink-soft mb-2">Sign on which side?</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setSigningFace('back')}
                      className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                        signingFace === 'back'
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-card text-ink-soft hover:border-accent/50'
                      }`}>
                      <span className="text-lg">👕</span>
                      <span>Back <span className="text-xs opacity-60">(Name side)</span></span>
                    </button>
                    <button type="button" onClick={() => setSigningFace('front')}
                      className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                        signingFace === 'front'
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-card text-ink-soft hover:border-accent/50'
                      }`}>
                      <span className="text-lg">👔</span>
                      <span>Front <span className="text-xs opacity-60">(Logo side)</span></span>
                    </button>
                  </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-2">
                  <Tab active={tab === 'draw'} onClick={() => setTab('draw')}>✏️ Draw</Tab>
                  <Tab active={tab === 'upload'} onClick={() => setTab('upload')}>📷 Upload</Tab>
                </div>

                {/* ── Draw tab ── */}
                {tab === 'draw' && (
                  <div className="space-y-3">
                    {/* Ink colour picker */}
                    <div>
                      <p className="text-xs font-medium text-ink-soft mb-2">Ink colour</p>
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {INK_COLORS.map((c) => (
                          <button key={c.hex} type="button" title={c.label}
                            onClick={() => setInkColor(c.hex)}
                            className="w-6 h-6 rounded-full border-2 transition-all hover:scale-110 focus:outline-none"
                            style={{
                              backgroundColor: c.hex,
                              borderColor: inkColor === c.hex ? '#ffffff' : 'transparent',
                              boxShadow: inkColor === c.hex ? `0 0 0 2px ${c.hex}, 0 0 0 3px rgba(255,255,255,0.6)` : 'inset 0 0 0 1px rgba(0,0,0,0.15)',
                            }}
                          />
                        ))}
                        {/* Custom colour */}
                        <label title="Custom colour"
                          className="relative w-6 h-6 rounded-full border-2 border-dashed border-border cursor-pointer grid place-items-center hover:border-accent transition-colors overflow-hidden"
                          style={{ borderColor: INK_COLORS.every(c => c.hex.toLowerCase() !== inkColor.toLowerCase()) ? '#a07040' : undefined }}>
                          <input type="color" className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                            value={inkColor} onChange={(e) => setInkColor(e.target.value)} />
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-ink-soft pointer-events-none"><path d="M12 2v20M2 12h20" /></svg>
                        </label>
                        {/* Selected colour swatch preview */}
                        <div className="ml-1 flex items-center gap-1.5 text-xs text-ink-faint">
                          <div className="w-4 h-4 rounded-full border border-border" style={{ backgroundColor: inkColor }} />
                          <span className="font-mono">{inkColor}</span>
                        </div>
                      </div>
                    </div>

                    {/* Canvas */}
                    <div className="relative rounded-xl overflow-hidden border border-border">
                      <canvas
                        ref={canvasRef}
                        className="block w-full h-48 touch-none"
                        style={{ background: 'rgba(255,255,255,0.03)', cursor: 'crosshair' }}
                        onPointerDown={beginDraw}
                        onPointerMove={moveDraw}
                        onPointerUp={endDraw}
                        onPointerCancel={endDraw}
                      />
                      {!hasStrokes && (
                        <div className="absolute inset-0 grid place-items-center pointer-events-none select-none">
                          <p className="text-sm text-ink-faint italic">Sign here…</p>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2 justify-between items-center">
                      <button type="button" onClick={clearCanvas} disabled={!hasStrokes}
                        className="px-3 py-1.5 rounded-lg text-xs text-ink-soft hover:text-ink hover:bg-mist transition-colors disabled:opacity-30">
                        Clear
                      </button>
                      <button type="button" onClick={finishDraw} disabled={!hasStrokes}
                        className="px-4 py-1.5 rounded-lg bg-accent text-accent-text text-xs font-semibold hover:bg-accent-hover transition-colors disabled:opacity-40">
                        Use this signature →
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Upload tab ── */}
                {tab === 'upload' && (
                  <label className="block border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:bg-mist/60 transition-colors">
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
                    <svg className="mx-auto mb-2 text-ink-faint" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <p className="text-sm text-ink-soft">Drop an image here or tap to choose.</p>
                    <p className="text-xs text-ink-faint mt-1">White paper works best. PNG/JPG. We'll auto-remove the background.</p>
                  </label>
                )}

                {/* Signer name */}
                <div>
                  <label className="block text-xs font-medium text-ink-soft mb-1.5">Your name</label>
                  <input type="text" value={signerName} onChange={(e) => setSignerName(e.target.value)}
                    maxLength={60} placeholder="Your full name"
                    className="w-full bg-bg border border-border rounded-xl px-4 py-2.5 text-ink focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" />
                </div>

                {error && (
                  <p className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{error}</p>
                )}
              </motion.div>
            )}

            {phase === 'place' && pendingSig && (
              <motion.div key="place" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -18 }} className="p-6 space-y-4">
                <div className="grid place-items-center min-h-[300px]">
                  <div className="w-full max-w-[320px]">
                    <PremiumTee shirtColor={shirtColor} textColor={textColor}
                      customShirtHex={customShirtHex} customTextHex={customTextHex}
                      nameOnBack={nameOnBack}
                      side={pendingSig.face ?? 'back'} signatures={[...existingSignatures, pendingSig]} editable
                      onChangeSignature={(id, next) => { if (id === pendingSig.id) updatePending(next); }} />
                  </div>
                </div>
                <p className="text-[11px] text-ink-faint text-center">
                  Drag to move · drag the bottom-right handle to resize · drag the top dot to rotate.
                </p>
                {error && (
                  <p className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{error}</p>
                )}
                <div className="flex items-center justify-between border-t border-border pt-4">
                  <button type="button"
                    onClick={() => { setPendingSig(null); setPhase('capture'); }}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-ink-soft hover:text-ink hover:bg-mist transition-colors">
                    ← Redo
                  </button>
                  <button type="button" onClick={save}
                    className="px-5 py-2.5 rounded-lg bg-accent text-accent-text font-semibold hover:bg-accent-hover transition-colors">
                    Save signature
                  </button>
                </div>
              </motion.div>
            )}

            {phase === 'submitting' && (
              <motion.div key="submitting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="p-12 grid place-items-center">
                <div className="w-10 h-10 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
        active ? 'bg-accent text-accent-text' : 'bg-mist text-ink-soft hover:text-ink hover:bg-mist/70'
      }`}>
      {children}
    </button>
  );
}

void SignatureTool;
