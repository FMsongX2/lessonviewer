import { useEffect, useReducer, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { InkStrokes } from "../../shared/types";
import { IconEraser, IconHighlighter, IconLeft, IconPen, IconRedo, IconRight, IconTrash, IconUndo } from "./icons";
import { InkLayer, InkSurface, type Brush, type InkTool } from "./Ink";
import { flushInk, retryInk, setStrokes, useSaveState, useStrokes, type InkRef } from "./inkStore";
import { usePref } from "./prefs";

export type ZoomItem = { src: string; id: string; label: string; ink?: InkRef };

// 펜은 pdfnote 펜 색(빨강·파랑)에 검정, 형광펜은 글자를 가리지 않는 밝은 세 색
const PEN_COLORS = [["#e11d48", "빨강"], ["#2563eb", "파랑"], ["#1b2232", "검정"]] as const;
const HL_COLORS = [["#facc15", "노랑"], ["#4ade80", "초록"], ["#f472b6", "분홍"]] as const;
const PEN_SIZES = [1.6, 2.6, 4.2];
const HL_SIZES = [12, 18, 26];
const SIZE_LABEL = ["가늘게", "보통", "굵게"];
const SAVE_LABEL = { idle: "", saving: "저장 중", saved: "저장됨", error: "" } as const;

type History = { undo: InkStrokes[]; redo: InkStrokes[] };

// 슬라이드 크게 보기. 처음 연 슬라이드는 제자리에서 커지고, ←→로 넘긴 슬라이드는 바꿔 끼움.
// 필기 모드에서는 슬라이드 위에 펜·형광펜으로 쓰고 지울 수 있고, 쓰는 대로 저장됨
export function Lightbox({ items, index, onIndex, onClose, drawing, onDrawing, inkVisible = true }: {
  items: ZoomItem[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  drawing: boolean;
  onDrawing: (on: boolean) => void;
  inkVisible?: boolean;
}) {
  const first = useRef<number | null>(null);
  if (index === null) first.current = null;
  else if (first.current === null) first.current = index;
  const item = index === null ? null : items[index];
  const shared = index !== null && first.current === index;
  const ink = item?.ink ?? null;
  const canDraw = !!ink;
  const draw = drawing && canDraw;

  const strokes = useStrokes(ink);
  const saveState = useSaveState();
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const aspect = item ? aspects[item.src] : undefined;

  const [tool, setTool] = usePref<InkTool>("inkTool", "pen");
  const [pen, setPen] = usePref<Brush>("inkPen", { c: PEN_COLORS[0][0], w: PEN_SIZES[1]! });
  const [hl, setHl] = usePref<Brush>("inkHl", { c: HL_COLORS[0][0], w: HL_SIZES[1]! });
  // 지우개일 때도 펜의 색·굵기를 흐리게 보여 주고, 고르면 바로 펜으로 돌아감
  const brushTool = tool === "hl" ? "hl" : "pen";
  const brush = brushTool === "hl" ? hl : pen;
  const pickBrush = (b: Brush) => { (brushTool === "hl" ? setHl : setPen)(b); if (tool === "eraser") setTool("pen"); };
  const colors = brushTool === "hl" ? HL_COLORS : PEN_COLORS;
  const sizes = brushTool === "hl" ? HL_SIZES : PEN_SIZES;
  const erasing = tool === "eraser";

  // 되돌리기 기록은 쪽마다 따로, 크게 보기를 닫을 때까지 유지
  const histories = useRef(new Map<string, History>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const histKey = ink ? `${ink.lecture}/${ink.page}:${ink.base}` : "";
  const hist = () => {
    let h = histories.current.get(histKey);
    if (!h) histories.current.set(histKey, (h = { undo: [], redo: [] }));
    return h;
  };
  const commit = (next: InkStrokes) => {
    if (!ink) return;
    hist().undo.push(strokes);
    hist().redo = [];
    setStrokes(ink, next);
    rerender();
  };
  const undo = () => {
    const h = hist(), prev = h.undo.pop();
    if (!ink || !prev) return;
    h.redo.push(strokes);
    setStrokes(ink, prev);
    rerender();
  };
  const redo = () => {
    const h = hist(), next = h.redo.pop();
    if (!ink || !next) return;
    h.undo.push(strokes);
    setStrokes(ink, next);
    rerender();
  };
  const canUndo = !!histories.current.get(histKey)?.undo.length;
  const canRedo = !!histories.current.get(histKey)?.redo.length;

  const close = () => { flushInk(); onClose(); };

  useEffect(() => {
    if (index === null) { histories.current.clear(); return; }
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") { if (draw) onDrawing(false); else close(); }
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      else if (draw && mod && (e.code === "KeyZ" || k === "z")) { if (e.shiftKey) redo(); else undo(); }
      else if (draw && mod && (e.code === "KeyY" || k === "y")) redo();
      else if (mod || e.altKey) return;
      else if (canDraw && (k === "d" || k === "ㅇ")) onDrawing(!draw);
      else if (draw && (k === "p" || k === "ㅔ")) setTool("pen");
      else if (draw && (k === "h" || k === "ㅗ")) setTool("hl");
      else if (draw && (k === "e" || k === "ㄷ")) setTool("eraser");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  });

  const step = (d: number) => (e: MouseEvent) => {
    e.stopPropagation();
    if (index !== null) onIndex(Math.min(items.length - 1, Math.max(0, index + d)));
  };

  return createPortal(
    <AnimatePresence>
      {item && index !== null && (
        <motion.div className={`lightbox${draw ? " drawing" : ""}`} onClick={draw ? undefined : close} role="dialog"
          aria-label={draw ? "슬라이드에 필기하기" : "슬라이드 크게 보기"}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="lb-stage" onClick={draw ? (e) => e.stopPropagation() : undefined}>
            <motion.img key={item.id} layoutId={shared ? item.id : undefined} src={item.src} alt="" draggable={false}
              onLoad={(e) => { const im = e.currentTarget; setAspects((a) => ({ ...a, [item.src]: im.naturalWidth / im.naturalHeight })); }}
              initial={shared ? false : { opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} />
            {aspect && (draw
              ? <InkSurface key={item.id} strokes={strokes} aspect={aspect} tool={tool} brush={brush} onCommit={commit} />
              : inkVisible && strokes.length > 0 && <InkLayer strokes={strokes} aspect={aspect} />)}
          </div>

          <AnimatePresence>
            {draw && (
              <motion.div className="lb-tools" role="toolbar" aria-label="필기 도구" onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
                <div className="lt-group">
                  <button aria-pressed={tool === "pen"} onClick={() => setTool("pen")} title="펜 (p)" aria-label="펜"><IconPen /></button>
                  <button aria-pressed={tool === "hl"} onClick={() => setTool("hl")} title="형광펜 (h). Shift를 누르고 그으면 곧은 줄" aria-label="형광펜"><IconHighlighter /></button>
                  <button aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")} title="지우개 (e). 닿은 획을 통째로 지워" aria-label="지우개"><IconEraser /></button>
                </div>
                <div className={`lt-group${erasing ? " dim" : ""}`} role="group" aria-label="색">
                  {colors.map(([c, name]) => (
                    <button key={c} className="swatch" style={{ "--sw": c } as CSSProperties} aria-pressed={!erasing && brush.c === c}
                      onClick={() => pickBrush({ ...brush, c })} title={name} aria-label={name} />
                  ))}
                </div>
                <div className={`lt-group${erasing ? " dim" : ""}`} role="group" aria-label="굵기">
                  {sizes.map((w, i) => (
                    <button key={w} className="size" aria-pressed={!erasing && brush.w === w} onClick={() => pickBrush({ ...brush, w })}
                      title={SIZE_LABEL[i]} aria-label={SIZE_LABEL[i]}>
                      <span style={{ width: 4 + i * 4, height: 4 + i * 4, background: brushTool === "hl" ? brush.c : "currentColor" }} />
                    </button>
                  ))}
                </div>
                <div className="lt-group">
                  <button onClick={undo} disabled={!canUndo} title="되돌리기 (⌘Z)" aria-label="되돌리기"><IconUndo /></button>
                  <button onClick={redo} disabled={!canRedo} title="다시 하기 (⇧⌘Z)" aria-label="다시 하기"><IconRedo /></button>
                  <button onClick={() => commit([])} disabled={!strokes.length} title="이 쪽 필기 모두 지우기. ⌘Z로 되돌릴 수 있어" aria-label="이 쪽 필기 모두 지우기"><IconTrash /></button>
                </div>
                <span className="lt-save" role="status">
                  {saveState === "error"
                    ? <button className="lt-retry" onClick={retryInk}>저장 못 했어 · 다시 시도</button>
                    : SAVE_LABEL[saveState]}
                </span>
                <button className="lt-done" onClick={() => onDrawing(false)} title="필기 끝내기 (esc)">완료</button>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
            <button onClick={step(-1)} disabled={index === 0} aria-label="이전 슬라이드"><IconLeft /></button>
            <span className="lb-label">{item.label}</span>
            <span className="lb-count">{index + 1} / {items.length}</span>
            {canDraw && (
              <button className="lb-draw" aria-pressed={draw} onClick={() => onDrawing(!draw)}
                title={draw ? "필기 끝내기 (d)" : "이 쪽에 필기하기 (d)"} aria-label={draw ? "필기 끝내기" : "필기하기"}><IconPen /></button>
            )}
            <button onClick={step(1)} disabled={index === items.length - 1} aria-label="다음 슬라이드"><IconRight /></button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
