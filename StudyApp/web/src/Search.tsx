import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useModalFocus, usePop } from "./Toolbar";
import type { CourseInfo, SearchEntry } from "../../shared/types";
import { api } from "./api";
import { IconSearch } from "./icons";
import { href } from "./route";
import { plainText } from "./plain";
import { usePref } from "./prefs";

// 수식·Markdown 기호와 PDF 글머리표(사용자 영역 문자)를 걷어 낸 검색·미리보기용 글
const plain = (s: string) => plainText(s.replace(/[\uE000-\uF8FF\u25AA\u25A0]/g, "").replace(/```\w*\n?/g, " ").replace(/[#>|]/g, "")).replace(/\s+/g, " ");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Scope = "course" | "all";
type Indexed = SearchEntry & { course: string; order: number; t: string; b: string; x: string; bodyPlain: string; textPlain: string };

function highlight(text: string, terms: string[]): ReactNode[] {
  if (!terms.length) return [text];
  const re = new RegExp(`(${terms.map(escape).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

// 처음 맞은 단어 앞뒤만 잘라 보여 줌
function snippet(e: Indexed, terms: string[]) {
  const src = terms.some((t) => e.b.includes(t)) ? e.bodyPlain : terms.some((t) => e.x.includes(t)) ? e.textPlain : e.bodyPlain;
  const lower = src.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Infinity);
  if (!Number.isFinite(at)) return src.slice(0, 120);
  const from = Math.max(0, at - 36);
  return (from > 0 ? "…" : "") + src.slice(from, from + 140) + (from + 140 < src.length ? "…" : "");
}

export function Search({ course, courses, open, onClose }: { course: string; courses: CourseInfo[]; open: boolean; onClose: () => void }) {
  const [scope, setScope] = usePref<Scope>("searchScope", "course");
  const [entries, setEntries] = useState<Record<string, SearchEntry[]>>({});
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const pop = usePop();
  const targets = scope === "all" ? courses.map((c) => c.id) : [course];
  useModalFocus(open, sheetRef);

  // 열 때마다 새로 받음. 해설이 바뀌었을 수 있고, 과목 하나에 수백 장이라 가벼움. 실패한 과목은 숨기지 않고 알림
  useEffect(() => {
    if (!open) return;
    let live = true;
    for (const id of targets) {
      api.search(id)
        .then((list) => {
          if (!live) return;
          setEntries((prev) => ({ ...prev, [id]: list }));
          setFailed((prev) => { const { [id]: _, ...rest } = prev; return rest; });
        })
        .catch((e) => { if (live) setFailed((prev) => ({ ...prev, [id]: String(e) })); });
    }
    return () => { live = false; };
  }, [open, targets.join(","), attempt]);
  useEffect(() => { if (!open) { setQuery(""); setSel(0); setFailed({}); } }, [open]);
  const retry = useCallback(() => { setFailed({}); setAttempt((n) => n + 1); }, []);
  const failedIds = targets.filter((id) => failed[id]);
  const pending = targets.filter((id) => !entries[id] && !failed[id]);
  const titleOf = (id: string) => courses.find((c) => c.id === id)?.title ?? id;

  const byId = useMemo(() => new Map(courses.flatMap((c, ci) => c.lectures.map((l, li) => [`${c.id}/${l.id}`, { c, l, order: ci * 1_000_000 + li * 1000 }] as const))), [courses]);
  const index = useMemo<Indexed[]>(() => targets.flatMap((cid) => (entries[cid] ?? []).map((e) => {
    const bodyPlain = plain(e.body), textPlain = plain(e.text);
    return { ...e, course: cid, order: (byId.get(`${cid}/${e.lecture}`)?.order ?? 9e9) + e.page, t: plain(e.title).toLowerCase(), b: bodyPlain.toLowerCase(), x: textPlain.toLowerCase(), bodyPlain, textPlain };
  })), [entries, byId, targets.join(",")]);

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const results = useMemo(() => {
    if (!terms.length) return [];
    return index
      .filter((e) => terms.every((t) => e.t.includes(t) || e.b.includes(t) || e.x.includes(t)))
      .map((e) => ({ e, score: terms.reduce((s, t) => s + (e.t.includes(t) ? 6 : e.b.includes(t) ? 3 : 1), 0) + (e.kind === "beat" ? 2 : 0) + (e.tag === "core" ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || a.e.order - b.e.order)
      .slice(0, scope === "all" ? 60 : 40)
      .map((r) => r.e);
  }, [index, terms]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const go = (e: Indexed) => { location.hash = href.lecture(e.course, e.lecture, e.page); onClose(); };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "ArrowDown") setSel((s) => Math.min(results.length - 1, s + 1));
    else if (ev.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
    else if (ev.key === "Enter" && results[sel]) go(results[sel]);
    else if (ev.key === "Tab") setScope((s) => (s === "all" ? "course" : "all"));
    else return;
    ev.preventDefault();
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <motion.div ref={sheetRef} className="sheet palette" role="dialog" aria-modal="true" aria-label="검색" tabIndex={-1}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }} {...pop}>
            <label className="palette-input">
              <IconSearch />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
                placeholder={scope === "all" ? "모든 과목에서 개념, 키워드, 슬라이드 문장 찾기" : "개념, 키워드, 슬라이드 문장으로 찾기"} aria-label="검색어" role="combobox"
                aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={`${uid}-results`}
                aria-activedescendant={results[sel] ? `${uid}-opt-${sel}` : undefined} />
              <span className="scope" role="radiogroup" aria-label="검색 범위">
                <button role="radio" aria-checked={scope === "course"} onClick={() => setScope("course")}>이 과목</button>
                <button role="radio" aria-checked={scope === "all"} onClick={() => setScope("all")}>모든 과목</button>
              </span>
            </label>
            {failedIds.length > 0 && (
              <p className="palette-alert" role="alert">
                {failedIds.length === targets.length ? "검색 목록을 불러오지 못했어요." : `${failedIds.map(titleOf).join(", ")} 검색 목록을 불러오지 못해 결과에서 빠졌어요.`}
                <button className="link" onClick={retry}>다시 불러오기</button>
              </p>
            )}
            <p className="sr-only" role="status" aria-live="polite">
              {pending.length > 0 ? "검색 목록을 불러오는 중이에요." : terms.length ? `결과 ${results.length}개` : ""}
            </p>
            {terms.length > 0 && results.length > 0 && (
              <ul className="results" id={`${uid}-results`} role="listbox" aria-label="검색 결과" ref={listRef}>
                {results.map((e, i) => {
                  const hit = byId.get(`${e.course}/${e.lecture}`);
                  return (
                    <li key={`${e.course}-${e.kind}-${e.lecture}-${e.page}-${e.title}`} id={`${uid}-opt-${i}`} data-i={i} role="option" aria-selected={i === sel}
                      onMouseMove={() => setSel(i)} onClick={() => go(e)}>
                      <span className="r-title">
                        {e.kind === "beat" && <span className="r-kind">이야기</span>}
                        {highlight(plain(e.title), terms)}
                      </span>
                      <span className="r-where">{scope === "all" && <b>{hit?.c.title}</b>}{hit?.l.week} p.{e.page}</span>
                      <span className="r-snip">{highlight(snippet(e, terms), terms)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {terms.length > 0 && !results.length && pending.length > 0 && (
              <p className="palette-empty">검색 목록을 불러오는 중이에요.</p>
            )}
            {terms.length > 0 && !results.length && !pending.length && (
              <p className="palette-empty">
                "{query}"와 맞는 슬라이드가 없어요. 영어 원어나 더 짧은 단어로 찾아보세요.
                {scope === "course" && <> <button className="link" onClick={() => setScope("all")}>모든 과목에서 찾기</button></>}
              </p>
            )}
            {!terms.length && (
              <p className="palette-empty">
                해설, 이야기, 슬라이드 원문을 함께 찾아요. 여러 단어를 쓰면 모두 들어간 결과만 보여 줘요.
                <span className="palette-keys"><kbd>↑</kbd><kbd>↓</kbd> 고르기 <kbd>enter</kbd> 열기 <kbd>tab</kbd> 범위 바꾸기 <kbd>esc</kbd> 닫기</span>
              </p>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
