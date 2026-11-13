import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconMoon, IconSliders, IconSun } from "./icons";
import type { Point } from "./theme";

// 상단 도구줄 가운데 칸. 화면마다 자기 도구를 여기에 그림
export const SlotContext = createContext<HTMLElement | null>(null);
export function ToolbarSlot({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  return slot ? createPortal(children, slot) : null;
}

// 창이 열리고 닫히는 움직임. 움직임 줄이기 설정이면 위치·크기 변화 없이 투명도만 바꿈
export function usePop() {
  const reduced = useReducedMotion();
  return reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.01 } }
    : { initial: { opacity: 0, y: -4, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -4, scale: 0.98 }, transition: { duration: 0.14 } };
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
}

// 덮개 창(검색·단축키·모듈 창)의 키보드 규칙: 열면 안으로 초점, tab은 창 안에서만 돌고, 닫으면 연 자리로 초점이 돌아감
export function useModalFocus(open: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      (root.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables(root)[0] ?? root).focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key !== "Tab" || e.defaultPrevented || !root) return;
      const items = focusables(root);
      if (!items.length) { e.preventDefault(); root.focus(); return; }
      const first = items[0], last = items[items.length - 1], at = document.activeElement;
      if (!root.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("keydown", onKey);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open, ref]);
}

// 버튼 아래로 열리는 작은 창. 바깥을 누르거나 esc로 닫힘.
// 열면 고른 항목(없으면 첫 항목)으로 초점이 가고, esc로 닫으면 연 버튼으로 돌아감. 초점이 창 밖으로 나가도 닫힘
// floating: 넘침을 자르는 칸(강의 목록 열) 안에서는 창이 잘리므로, body에 띄워 버튼 아래 자리에 고정함
export function Popover({ trigger, children, label, align = "start", floating = false }: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  align?: "start" | "end";
  floating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pop = usePop();
  const returnFocus = () => ref.current?.querySelector<HTMLElement>("button, a[href]")?.focus({ preventScroll: true });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false); e.stopPropagation(); returnFocus();
    };
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey, true);
    addEventListener("focusin", onFocus);
    return () => { removeEventListener("mousedown", onDown); removeEventListener("keydown", onKey, true); removeEventListener("focusin", onFocus); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !floating) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, innerWidth - 300)) });
    };
    place();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => { removeEventListener("resize", place); removeEventListener("scroll", place, true); };
  }, [open, floating]);
  // 창이 그려진 다음 고른 항목으로 초점을 옮김
  const ready = open && (!floating || !!at);
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const picked = panel.querySelector<HTMLElement>('[aria-current], [aria-checked="true"]');
      (picked && focusables(panel).includes(picked) ? picked : focusables(panel)[0] ?? panel).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  const panel = ready && (
    <motion.div ref={panelRef} className={`pop-panel ${align}${floating ? " floating" : ""}`} role="dialog" aria-label={label} tabIndex={-1}
      style={floating && at ? { top: at.top, left: at.left } : undefined} {...pop}>
      {children(() => { setOpen(false); returnFocus(); })}
    </motion.div>
  );
  return (
    <div className="pop" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {floating
        ? createPortal(<AnimatePresence>{panel}</AnimatePresence>, document.body)
        : <AnimatePresence>{panel}</AnimatePresence>}
    </div>
  );
}

// 하나만 고르는 버튼 묶음. 고른 칸 뒤의 알약이 미끄러지듯 옮겨 감
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const group = useId();
  const reduced = useReducedMotion();
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} title={o.title} onClick={() => onChange(o.id)}>
          {value === o.id && <motion.span className="seg-pill" layoutId={group} transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40 }} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export type Theme = "system" | "light" | "dark";
export type TextSize = "s" | "m" | "l";

export function Settings({ theme, setTheme, text, setText }: {
  theme: Theme; setTheme: (t: Theme) => void; text: TextSize; setText: (t: TextSize) => void;
}) {
  return (
    <Popover label="보기 설정" align="end" trigger={({ open, toggle }) => (
      <button className="icon-btn" aria-expanded={open} onClick={toggle} title="보기 설정"><IconSliders /></button>
    )}>
      {() => (
        <div className="settings">
          <p className="pop-label">해설 글자 크기</p>
          <Segmented label="해설 글자 크기" value={text} onChange={setText}
            options={[{ id: "s", label: "작게" }, { id: "m", label: "보통" }, { id: "l", label: "크게" }]} />
          <p className="pop-label">화면</p>
          <Segmented label="화면 밝기" value={theme} onChange={setTheme}
            options={[{ id: "system", label: "시스템" }, { id: "light", label: "밝게" }, { id: "dark", label: "어둡게" }]} />
          <p className="pop-note">슬라이드랑 해설 사이 경계를 끌면 너비가 바뀌고, 더블클릭하면 처음 비율로 돌아가.</p>
        </div>
      )}
    </Popover>
  );
}

// 해·달 버튼. 지금 어두우면 해(밝게 바꾸기), 밝으면 달(어둡게 바꾸기)을 보여 줌
export function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: (from: Point) => void }) {
  const label = dark ? "밝은 화면으로 바꾸기 (t)" : "어두운 화면으로 바꾸기 (t)";
  const reduced = useReducedMotion();
  return (
    <button className="icon-btn theme-btn" title={label} aria-label={label} onClick={(e) => {
      const r = e.currentTarget.getBoundingClientRect();
      onToggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={dark ? "sun" : "moon"} className="theme-icon"
          initial={reduced ? { opacity: 0 } : { opacity: 0, rotate: -80, scale: 0.5 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, rotate: 80, scale: 0.5 }}
          transition={reduced ? { duration: 0.01 } : { type: "spring", stiffness: 420, damping: 26 }}>
          {dark ? <IconSun /> : <IconMoon />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

const KEYS: [string[], string][] = [
  [["j", "k"], "다음, 이전 슬라이드"],
  [["f"], "다시 볼 슬라이드로 표시"],
  [["s"], "별표 하기, 빼기"],
  [["d"], "지금 쪽에 필기하기. 크게 보기에서도 돼"],
  [["p", "h", "e"], "필기 중 펜, 형광펜, 지우개"],
  [["⌘Z", "⇧⌘Z"], "필기 되돌리기, 다시 하기"],
  [["i"], "내 필기 켜고 끄기"],
  [["p"], "작년 자료 켜고 끄기"],
  [["1", "2", "3"], "핵심만, 기본, 전체 보기"],
  [["["], "강의 목록 숨기기, 보이기"],
  [["t"], "밝은 화면, 어두운 화면 바꾸기"],
  [["/"], "검색. ⌘K로도 열림"],
  [["←", "→"], "크게 보기에서 이전, 다음 슬라이드"],
  [["esc"], "필기 끝내기, 열린 창 닫기"],
];

export function Help({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const pop = usePop();
  const titleId = useId();
  useModalFocus(open, sheetRef);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); onClose(); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <motion.div ref={sheetRef} className="sheet help" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} {...pop}>
            <div className="sheet-head">
              <h2 id={titleId}>단축키</h2>
              <button className="text-btn" onClick={onClose}>닫기</button>
            </div>
            <dl>
              {KEYS.map(([keys, desc]) => (
                <div key={desc}>
                  <dt>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
            <p className="pop-note">한글 자판에서도 같은 자리의 키로 동작해요.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
