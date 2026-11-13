import { useCallback, useMemo, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { usePref } from "./prefs";
import { holdReadingPosition } from "./anchor";

// 슬라이드(왼쪽)가 차지하는 비율. 모든 슬라이드 줄이 같은 값을 씀
export const SPLIT_DEFAULT = 0.54;
const MIN = 0.28, MAX = 0.76;
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

export type SplitHandlers = {
  value: number;
  start: (e: PointerEvent<HTMLElement>) => void;
  key: (e: KeyboardEvent<HTMLElement>) => void;
  reset: () => void;
};

export function useSplit() {
  const [split, setSplit] = usePref("split", SPLIT_DEFAULT);
  const hostRef = useRef<HTMLDivElement>(null);

  // 끄는 동안은 CSS 변수만 직접 바꿔 React 렌더 없이 따라오게 하고, 놓을 때 저장함.
  // 위쪽 줄들 높이가 같이 변하므로, 잡고 있는 줄이 화면에서 제자리에 있도록 스크롤을 보정함
  const start = useCallback((e: PointerEvent<HTMLElement>) => {
    const handle = e.currentTarget;
    const row = handle.closest<HTMLElement>(".slide");
    const host = hostRef.current;
    if (!row || !host || e.button !== 0) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const anchor = rect.top;
    let ratio = split;
    handle.setPointerCapture(e.pointerId);
    document.documentElement.classList.add("resizing");
    const move = (ev: globalThis.PointerEvent) => {
      ratio = clamp((ev.clientX - rect.left) / rect.width);
      host.style.setProperty("--split", `${(ratio * 100).toFixed(2)}%`);
      const drift = row.getBoundingClientRect().top - anchor;
      if (Math.abs(drift) >= 1) scrollBy(0, drift);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("resizing");
      holdReadingPosition();
      setSplit(ratio);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }, [split, setSplit]);

  const key = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 0.06 : 0.02;
    if (e.key === "ArrowLeft") setSplit((s) => clamp(s - step));
    else if (e.key === "ArrowRight") setSplit((s) => clamp(s + step));
    else if (e.key === "Enter" || e.key === "Home") setSplit(SPLIT_DEFAULT);
    else return;
    holdReadingPosition();
    e.preventDefault();
    e.stopPropagation();
  }, [setSplit]);

  const reset = useCallback(() => { holdReadingPosition(); setSplit(SPLIT_DEFAULT); }, [setSplit]);
  const handlers = useMemo<SplitHandlers>(() => ({ value: split, start, key, reset }), [split, start, key, reset]);
  const style = { "--split": `${(split * 100).toFixed(2)}%` } as CSSProperties;
  return { hostRef, style, handlers };
}
