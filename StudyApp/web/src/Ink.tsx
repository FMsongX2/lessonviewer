import { memo, useRef, useState, type PointerEvent } from "react";
import type { InkStroke, InkStrokes } from "../../shared/types";
import { hitStrokes, strokePath } from "./inkStore";

// 슬라이드 위에 필기를 겹쳐 그림. 감싸는 상자를 꽉 채우고, 클릭은 아래로 그대로 통과함
export const InkLayer = memo(function InkLayer({ strokes, aspect }: { strokes: InkStrokes; aspect: number }) {
  const h = 1000 / aspect;
  return (
    <svg className="ink-layer" viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {strokes.map((s, i) => <path key={i} d={strokePath(s, h)} fill={s.c} className={s.t === "hl" ? "hl" : undefined} />)}
    </svg>
  );
});

export type InkTool = "pen" | "hl" | "eraser";
export type Brush = { c: string; w: number };
export const ERASER_RADIUS = 10;   // 너비의 1/1000 단위

// 필기하는 면. 펜·형광펜은 획 하나를 다 쓰면, 지우개는 손을 떼면 onCommit으로 새 획 목록을 넘김
// Apple Pencil이 한 번이라도 닿으면 손가락 터치는 무시함(손바닥이 화면에 닿아도 줄이 그어지지 않게)
export function InkSurface({ strokes, aspect, tool, brush, onCommit }: {
  strokes: InkStrokes;
  aspect: number;
  tool: InkTool;
  brush: Brush;
  onCommit: (next: InkStrokes) => void;
}) {
  const h = 1000 / aspect;
  const svg = useRef<SVGSVGElement>(null);
  const penSeen = useRef(false);
  const active = useRef<{ id: number; erase: boolean; stroke: InkStroke; removed: Set<number> } | null>(null);
  const [live, setLive] = useState<InkStroke | null>(null);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<{ u: number; v: number } | null>(null);   // 지우개 범위 표시(비율 좌표)

  const at = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height };
  };

  const erase = (e: PointerEvent<SVGSVGElement>) => {
    const a = active.current!;
    const { u, v } = at(e);
    const hits = hitStrokes(strokes, u, v, ERASER_RADIUS, h).filter((i) => !a.removed.has(i));
    if (!hits.length) return;
    hits.forEach((i) => a.removed.add(i));
    setRemoved(new Set(a.removed));
  };

  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (active.current) return;
    if (e.pointerType === "pen") penSeen.current = true;
    else if (e.pointerType === "touch" && penSeen.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // 펜 뒤쪽 지우개 버튼(buttons 32)도 지우개로
    const isErase = tool === "eraser" || (e.buttons & 32) !== 0;
    const sim = e.pointerType !== "pen";
    const stroke: InkStroke = { t: tool === "hl" ? "hl" : "pen", c: brush.c, w: brush.w, ...(sim ? { sim: 1 as const } : {}), p: [] };
    active.current = { id: e.pointerId, erase: isErase, stroke, removed: new Set() };
    if (isErase) erase(e);
    else move(e);
  };

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const a = active.current;
    if (tool === "eraser" && e.pointerType !== "touch") setCursor(at(e));
    if (!a || a.id !== e.pointerId) return;
    if (a.erase) { erase(e); return; }
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const p = a.stroke.p;
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const { u, v } = at(ev);
      const pressure = e.pointerType === "pen" ? ev.pressure || 0.5 : 0.5;
      // 형광펜 + Shift: 시작점에서 지금 점까지 곧은 줄
      if (a.stroke.t === "hl" && e.shiftKey && p.length >= 3) p.length = 3;
      p.push(Math.round(u * 10000) / 10000, Math.round(v * 10000) / 10000, Math.round(pressure * 100) / 100);
    }
    setLive({ ...a.stroke, p: [...p] });
  };

  const up = (e: PointerEvent<SVGSVGElement>) => {
    const a = active.current;
    if (!a || a.id !== e.pointerId) return;
    active.current = null;
    if (a.erase) {
      if (a.removed.size) onCommit(strokes.filter((_, i) => !a.removed.has(i)));
      setRemoved(new Set());
    } else {
      if (a.stroke.p.length >= 3) onCommit([...strokes, a.stroke]);
      setLive(null);
    }
  };

  const shown = removed.size ? strokes.filter((_, i) => !removed.has(i)) : strokes;
  return (
    <svg ref={svg} className={`ink-layer ink-surface tool-${tool}`} viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setCursor(null)}
      role="img" aria-label="필기하는 곳">
      {shown.map((s, i) => <path key={i} d={strokePath(s, h)} fill={s.c} className={s.t === "hl" ? "hl" : undefined} />)}
      {live && <path d={strokePath(live, h)} fill={live.c} className={live.t === "hl" ? "hl" : undefined} />}
      {tool === "eraser" && cursor && (
        <circle className="eraser-ring" cx={cursor.u * 1000} cy={cursor.v * h} r={ERASER_RADIUS} />
      )}
    </svg>
  );
}
