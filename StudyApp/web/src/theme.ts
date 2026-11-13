import { flushSync } from "react-dom";
import type { Theme } from "./Toolbar";

export type Point = { x: number; y: number };

// html의 data-theme. 시스템을 따르면 속성을 지우고 prefers-color-scheme에 맡김
export function applyThemeAttr(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
  // LessonViewer 앱 안이면 창 제목줄과 메뉴도 같은 밝기로 맞춤
  (window as { webkit?: { messageHandlers?: { theme?: { postMessage: (v: string) => void } } } })
    .webkit?.messageHandlers?.theme?.postMessage(theme);
}

// 화면 밝기를 바꿀 때, 누른 자리에서 새 화면이 둥글게 번져 나옴.
// View Transitions가 없거나 움직임 줄이기 설정이면 그냥 바로 바뀜
export function withReveal(change: () => void, from?: Point) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) { change(); return; }
  const x = from?.x ?? innerWidth - 40;
  const y = from?.y ?? 26;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  doc.startViewTransition(() => flushSync(change)).ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 520, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  }).catch(() => { /* 전환이 건너뛰어져도 바뀐 화면은 그대로 */ });
}

// 키보드로 바꿀 때는 도구줄의 해·달 버튼 자리에서 번짐
export function themeButtonCenter(): Point | undefined {
  const r = document.querySelector(".theme-btn")?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined;
}
