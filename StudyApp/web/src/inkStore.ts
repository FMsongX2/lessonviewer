// 앱에서 슬라이드 위에 직접 쓴 필기. 강의마다 한 번 받아 두고, 쓴 쪽만 잠깐 모았다가 서버에 저장함.
// 화면 여러 곳(슬라이드 줄, 크게 보기)이 같은 필기를 보므로 React 바깥의 작은 저장소로 둠.

import { useEffect, useSyncExternalStore } from "react";
import getStroke from "perfect-freehand";
import type { InkBase, InkStroke, InkStrokes } from "../../shared/types";
import { api } from "./api";
import type { SlideVariant } from "./api";

export type InkRef = { course: string; lecture: string; page: number; base: InkBase };
export type SaveState = "idle" | "saving" | "saved" | "error";

const EMPTY: InkStrokes = [];
const SAVE_DELAY = 500;

const lectures = new Map<string, Record<string, InkStrokes>>();   // "<course>/<lecture>" → "<쪽>:<base>" → 획
const listeners = new Set<() => void>();
const pending = new Map<string, { ref: InkRef; timer: number }>();
const failed = new Map<string, InkRef>();
let saveState: SaveState = "idle";

const lectureKey = (course: string, lecture: string) => `${course}/${lecture}`;
const pageKey = (r: InkRef) => `${r.page}:${r.base}`;
const fullKey = (r: InkRef) => `${lectureKey(r.course, r.lecture)}#${pageKey(r)}`;
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

// 작년 자료 이미지 위에 쓴 필기와 올해 이미지 위에 쓴 필기는 그림이 달라 따로 둠. pdfnote 필기본은 올해 쪽과 같은 그림
export const inkBase = (shown: SlideVariant): InkBase => (shown === "prev" ? "prev" : "clean");

function ensure(course: string, lecture: string) {
  const k = lectureKey(course, lecture);
  if (lectures.has(k)) return;
  lectures.set(k, {});
  api.ink(course, lecture).then((saved) => {
    // 받는 사이에 쓴 필기가 있으면 그쪽이 최신
    lectures.set(k, { ...saved, ...lectures.get(k) });
    emit();
  }).catch(() => lectures.delete(k));   // 다음에 다시 받음
}

export function getStrokes(r: InkRef): InkStrokes {
  return lectures.get(lectureKey(r.course, r.lecture))?.[pageKey(r)] ?? EMPTY;
}

export function useStrokes(r: InkRef | null): InkStrokes {
  useEffect(() => { if (r) ensure(r.course, r.lecture); }, [r?.course, r?.lecture]);
  return useSyncExternalStore(subscribe, () => (r ? getStrokes(r) : EMPTY));
}

// 이 강의에 앱 필기가 한 쪽이라도 있는지(도구줄 '내 필기' 단추를 보일지)
export function useHasInk(course: string, lecture: string): boolean {
  useEffect(() => ensure(course, lecture), [course, lecture]);
  return useSyncExternalStore(subscribe, () => Object.values(lectures.get(lectureKey(course, lecture)) ?? {}).some((s) => s.length > 0));
}

export function useSaveState(): SaveState {
  return useSyncExternalStore(subscribe, () => saveState);
}

function setSaveState(s: SaveState) {
  if (saveState !== s) { saveState = s; emit(); }
}

export function setStrokes(r: InkRef, strokes: InkStrokes) {
  const k = lectureKey(r.course, r.lecture);
  lectures.set(k, { ...lectures.get(k), [pageKey(r)]: strokes });
  const key = fullKey(r);
  clearTimeout(pending.get(key)?.timer);
  pending.set(key, { ref: r, timer: window.setTimeout(() => send(key), SAVE_DELAY) });
  setSaveState("saving");
  emit();
}

async function send(key: string, closing = false) {
  const p = pending.get(key);
  const ref = p?.ref ?? failed.get(key);
  pending.delete(key);
  failed.delete(key);
  if (!ref) return;
  try {
    await api.saveInk(ref.course, ref.lecture, ref.page, ref.base, getStrokes(ref), closing);
  } catch {
    if (!pending.has(key)) failed.set(key, ref);
  }
  if (!pending.size) setSaveState(failed.size ? "error" : "saved");
}

// 기다리던 저장을 지금 보냄. 크게 보기를 닫거나 창을 떠날 때
export function flushInk(closing = false) {
  for (const [key, p] of pending) { clearTimeout(p.timer); send(key, closing); }
}

export function retryInk() {
  if (!failed.size) return;
  setSaveState("saving");
  for (const key of [...failed.keys()]) send(key);
}

addEventListener("pagehide", () => flushInk(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushInk(true); });

// ── 그리기 ──
// 좌표는 너비 1000, 높이 1000/aspect 공간. 획 굵기 w도 너비의 1/1000 단위라 그대로 씀
const outlineCache = new WeakMap<InkStroke, { h: number; d: string }>();

export function strokePath(s: InkStroke, h: number): string {
  const hit = outlineCache.get(s);
  if (hit?.h === h) return hit.d;
  const pts: number[][] = [];
  for (let i = 0; i < s.p.length; i += 3) pts.push([s.p[i]! * 1000, s.p[i + 1]! * h, s.p[i + 2]!]);
  const outline = s.t === "hl"
    ? getStroke(pts, { size: s.w, thinning: 0, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last: true })
    : getStroke(pts, { size: s.w, thinning: 0.6, smoothing: 0.5, streamline: 0.4, simulatePressure: !!s.sim, last: true });
  const d = toPath(outline);
  outlineCache.set(s, { h, d });
  return d;
}

function toPath(points: number[][]): string {
  if (points.length < 2) return "";
  const r = (n: number) => Math.round(n * 100) / 100;
  let d = `M${r(points[0]![0]!)},${r(points[0]![1]!)}Q`;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    d += `${r(x0!)},${r(y0!)} ${r((x0! + x1!) / 2)},${r((y0! + y1!) / 2)} `;
  }
  return d + "Z";
}

// 지우개: (u, v) 비율 좌표에서 반지름 radius(너비 1/1000 단위) 안을 지나는 획의 번호
export function hitStrokes(strokes: InkStrokes, u: number, v: number, radius: number, h: number): number[] {
  const x = u * 1000, y = v * h;
  const out: number[] = [];
  strokes.forEach((s, i) => {
    const reach = radius + s.w / 2;
    for (let j = 0; j < s.p.length; j += 3) {
      const ax = s.p[j]! * 1000, ay = s.p[j + 1]! * h;
      const bx = j + 3 < s.p.length ? s.p[j + 3]! * 1000 : ax, by = j + 3 < s.p.length ? s.p[j + 4]! * h : ay;
      if (segDist(x, y, ax, ay, bx, by) <= reach) { out.push(i); return; }
    }
  });
  return out;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
