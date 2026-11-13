import { useCallback, useEffect, useState } from "react";

// 브라우저 저장소는 보기 설정만 기억함. 막혀 있어도 기본값으로 동작
export function loadPref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
export function savePref(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 안 돼도 무방 */ }
}

export function usePref<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => loadPref(key, fallback));
  const set = useCallback((next: T | ((prev: T) => T)) => setValue((prev) => {
    const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    savePref(key, v);
    return v;
  }), [key]);
  return [value, set] as const;
}

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

// 입력 중인 칸에서는 단축키를 먹지 않음
export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// 검색·도움말 같은 덮개 창이 열려 있으면 화면 단축키를 쉼
export const overlayOpen = () => !!document.body.dataset.overlay;
