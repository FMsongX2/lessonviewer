import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Beat, Lab, LectureData, LectureInfo, LectureProgress, Pack } from "../../shared/types";
import { api, showVariant, slideUrl } from "./api";
import type { Actions } from "./App";
import { BeatBlock } from "./BeatBlock";
import { IconChevron } from "./icons";
import { Lightbox, type ZoomItem } from "./Lightbox";
import { Inline } from "./Markdown";
import { isTyping, overlayOpen, useMedia, usePref } from "./prefs";
import { plainText } from "./plain";
import { href } from "./route";
import { SlideRow } from "./SlideRow";
import { Popover, Segmented, ToolbarSlot } from "./Toolbar";
import { LabBar } from "./LabBar";
import type { SlideCells } from "./SlideRow";
import { useSplit } from "./useSplit";
import { Loading } from "./Loading";
import { inkBase, useHasInk } from "./inkStore";
import { AgentPanel } from "./AgentPanel";
import { holdReadingPosition, measureAll, measureUntilFontsLoad } from "./anchor";
import "./integration.css";

type Mode = "core" | "default" | "all";
const MODES: { id: Mode; label: string; key: string; title: string }[] = [
  { id: "core", label: "핵심만", key: "1", title: "핵심 슬라이드만 펼침 (1)" },
  { id: "default", label: "기본", key: "2", title: "핵심과 보조를 펼치고 배경·표지는 접음 (2)" },
  { id: "all", label: "전체", key: "3", title: "모든 슬라이드를 펼침 (3)" },
];
const LINE = 140;   // 이 높이(도구줄 아래)를 지난 마지막 슬라이드·이야기를 '지금 위치'로 봄

type Item =
  | { kind: "beat"; beat: Beat; index: number }
  | { kind: "slide"; page: number }
  | { kind: "fold"; pages: number[] };

function isOpen(pack: Pack | null, page: number, mode: Mode, pinned: Set<number>) {
  if (!pack || mode === "all" || pinned.has(page)) return true;
  const tag = pack.slides[page - 1]?.tag;
  return mode === "core" ? tag === "core" : tag === "core" || tag === "support";
}

// 페이지를 순서대로 훑으며 beat를 첫 페이지 앞에 끼우고, 접힐 슬라이드는 연속 구간끼리 묶음
function buildItems(pageCount: number, pack: Pack | null, mode: Mode, pinned: Set<number>): Item[] {
  const beatAt = new Map(pack?.story.map((b, i) => [b.from, { beat: b, index: i + 1 }]) ?? []);
  const items: Item[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const b = beatAt.get(p);
    if (b) items.push({ kind: "beat", ...b });
    if (isOpen(pack, p, mode, pinned)) { items.push({ kind: "slide", page: p }); continue; }
    const last = items[items.length - 1];
    if (last?.kind === "fold") last.pages.push(p);
    else items.push({ kind: "fold", pages: [p] });
  }
  return items;
}

const range = (pages: number[]) => (pages.length > 1 ? `p.${pages[0]}–${pages[pages.length - 1]}` : `p.${pages[0]}`);
const beatRange = (b: Beat) => range(b.from === b.to ? [b.from] : [b.from, b.to]);

type Props = {
  course: string;
  lectureId: string;
  lectures: LectureInfo[];
  startPage?: number;
  progress?: LectureProgress;
  progressReady: boolean;
  actions: Actions;
};

// 밝기·목록 같은 바깥 상태가 바뀌어도 이 강의의 props가 그대로면 슬라이드 흐름 전체를 다시 렌더하지 않음
export const LectureView = memo(function LectureView({ course, lectureId, lectures, startPage, progress, progressReady, actions }: Props) {
  const [data, setData] = useState<LectureData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = usePref<Mode>("mode", "default");
  const [inkOn, setInkOn] = usePref("ink", true);
  const [prevOn, setPrevOn] = usePref("prev", true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());   // 펼친 접힘 구간의 페이지들
  const [current, setCurrent] = useState(1);
  const [beatNow, setBeatNow] = useState(0);                          // 0이면 첫 이야기 전
  const [zoom, setZoom] = useState<number | null>(null);              // 크게 보는 페이지의 index
  const [drawing, setDrawing] = useState(false);                      // 크게 보기에서 필기 중인지
  const split = useSplit();
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMounted, setAgentMounted] = useState(false);
  const compactAgent = useMedia("(max-width: 1319px)");
  const agentDock = useRef<HTMLElement | null>(null);
  const agentButton = useRef<HTMLButtonElement | null>(null);
  const source = useMemo(() => ({ kind: "lecture" as const, course, lecture: lectureId }), [course, lectureId]);
  const closeAgent = useCallback(() => { setAgentOpen(false); requestAnimationFrame(() => agentButton.current?.focus()); }, []);
  useEffect(() => {
    if (!agentOpen || !compactAgent) return;
    const panel = agentDock.current;
    document.body.dataset.agentOverlay = "1";
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAgent(); }
      if (event.key !== "Tab" || !panel) return;
      const fields = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')]
        .filter((el) => el.getClientRects().length > 0);
      const first = fields[0], last = fields.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); delete document.body.dataset.agentOverlay; document.body.style.overflow = before; };
  }, [agentOpen, compactAgent, closeAgent]);
  const streamRef = useRef<HTMLDivElement>(null);
  const navLock = useRef(0);
  const seenRef = useRef(new Set<number>());
  seenRef.current = new Set(progress?.seen);

  const load = useCallback(() => {
    setError(null);
    return api.lecture(course, lectureId).then(setData).catch(() => setError("강의 데이터를 불러오지 못했어요. 연결을 확인하고 다시 시도하세요."));
  }, [course, lectureId]);
  // 해설 속 코드를 실행하는 실습(있는 강의만)
  const [lab, setLab] = useState<Lab | null>(null);
  useEffect(() => { api.lab(course, lectureId).then(setLab).catch(() => setLab(null)); }, [course, lectureId]);
  const cellsByPage = useMemo(() => {
    const m = new Map<number, SlideCells>();
    lab?.cells.forEach((cell, index) => {
      if (!m.has(cell.page)) m.set(cell.page, new Map());
      m.get(cell.page)!.set(cell.block ?? 0, { index, cell });
    });
    return m;
  }, [lab]);
  // 실습 셀은 해설 속 코드 블록을 바꿔 끼우므로, 숨겨 둔 해설의 높이도 새로 잼
  useEffect(() => { if (lab) measureAll(); }, [lab]);
  useEffect(() => {
    load();
    addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, [load]);
  // 처음 그린 해설이 쓰는 폰트가 다 올 때까지는 먼 해설도 숨기지 않음(anchor.ts)
  const ready = !!data;
  useEffect(() => { if (ready) measureUntilFontsLoad(); }, [ready]);

  const pack = data?.pack ?? null;
  const pageCount = data?.pages.length ?? 0;
  const flagged = useMemo(() => new Set(progress?.flagged), [progress?.flagged]);
  const starred = useMemo(() => new Set(progress?.starred), [progress?.starred]);
  // 책갈피·별표를 한 쪽은 접힌 구간에 숨기지 않음
  const pinned = useMemo(() => new Set([...flagged, ...starred]), [flagged, starred]);
  const items = useMemo(() => (data ? buildItems(pageCount, pack, mode, pinned) : []), [data, pageCount, pack, mode, pinned]);
  const hasAppInk = useHasInk(course, lectureId);
  const hasInk = !!data?.pages.some((p) => p.ink) || hasAppInk;

  const changeMode = useCallback((m: Mode) => { setMode(m); setExpanded(new Set()); }, [setMode]);
  const toggleInk = useCallback(() => setInkOn((v) => !v), [setInkOn]);
  const hasPrev = !!data?.pages.some((p) => p.prev);
  const togglePrev = useCallback(() => setPrevOn((v) => !v), [setPrevOn]);
  const toggleFold = useCallback((pages: number[]) => setExpanded((prev) => {
    const next = new Set(prev);
    const open = pages.some((p) => prev.has(p));
    pages.forEach((p) => (open ? next.delete(p) : next.add(p)));
    return next;
  }), []);
  const flag = useCallback((page: number, on: boolean) => actions.flag(lectureId, page, on), [actions, lectureId]);
  const star = useCallback((page: number, on: boolean) => actions.star(lectureId, page, on), [actions, lectureId]);
  const onZoom = useCallback((page: number) => { setDrawing(false); setZoom(page - 1); }, []);
  const onDraw = useCallback((page: number) => { setDrawing(true); setZoom(page - 1); }, []);

  // 이동할 쪽을 바로 '지금 쪽'으로 정하고 저장함. 스크롤이 도착하는 동안의 중간값은 무시(navLock)
  const commitPage = useCallback((page: number) => {
    navLock.current = Date.now() + 900;
    setCurrent(page);
    actions.last(lectureId, page);
    history.replaceState(null, "", `#/${course}/${lectureId}?p=${page}`);
  }, [actions, course, lectureId]);

  // 해당 쪽으로 이동. 접힌 구간이면 펼친 뒤 이동
  const scrollToPage = useCallback((target: number, smooth: boolean) => {
    const fold = items.find((it) => it.kind === "fold" && it.pages.includes(target));
    if (fold?.kind === "fold") setExpanded((prev) => new Set([...prev, ...fold.pages]));
    commitPage(target);
    requestAnimationFrame(() => requestAnimationFrame(() =>
      document.getElementById(`p-${target}`)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" })));
  }, [items, commitPage]);
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });

  // 처음 열 때 주소의 p= 또는 마지막으로 보던 쪽으로
  const opened = useRef(false);
  useEffect(() => {
    if (!data || !progressReady || opened.current) return;
    opened.current = true;
    const target = startPage ?? progress?.lastPage ?? 1;
    if (target > 1) scrollToPage(target, false);
  }, [data, progressReady, startPage, progress?.lastPage, scrollToPage]);
  // 같은 강의 안에서 주소의 p=만 바뀐 경우(검색, 전체 흐름의 링크)
  const prevStart = useRef(startPage);
  useEffect(() => {
    if (!data || startPage === prevStart.current) return;
    prevStart.current = startPage;
    if (startPage) scrollToPage(startPage, true);
  }, [data, startPage, scrollToPage]);

  // 화면에 절반 이상 0.8초 머문 슬라이드를 읽음으로 기록
  useEffect(() => {
    const root = streamRef.current;
    if (!root || !data) return;
    const timers = new Map<number, number>();
    const pending = new Set<number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const page = Number((e.target as HTMLElement).dataset.page);
        if (e.isIntersecting && !seenRef.current.has(page) && !timers.has(page)) {
          timers.set(page, window.setTimeout(() => { pending.add(page); timers.delete(page); }, 800));
        } else if (!e.isIntersecting) {
          clearTimeout(timers.get(page));
          timers.delete(page);
        }
      }
    }, { threshold: 0.5 });
    root.querySelectorAll<HTMLElement>(".slide[data-page]").forEach((el) => io.observe(el));
    const flush = setInterval(() => {
      if (pending.size) { actions.seen(lectureId, [...pending]); pending.clear(); }
    }, 1500);
    return () => {
      io.disconnect();
      timers.forEach((t) => clearTimeout(t));
      clearInterval(flush);
      if (pending.size) actions.seen(lectureId, [...pending]);
    };
  }, [data, items, expanded, actions, lectureId]);

  // 지금 쪽과 지금 이야기. 멈추면 위치를 저장하고 주소에도 남김
  useEffect(() => {
    if (!data) return;
    let frame = 0, timer = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = streamRef.current;
        if (!root) return;
        let page = 1, beat = 0;
        for (const el of root.querySelectorAll<HTMLElement>(".slide[data-page]")) {
          if (el.getBoundingClientRect().top <= LINE) page = Number(el.dataset.page); else break;
        }
        for (const el of root.querySelectorAll<HTMLElement>(".beat[data-index]")) {
          if (el.getBoundingClientRect().top <= LINE) beat = Number(el.dataset.index); else break;
        }
        setBeatNow(beat);
        clearTimeout(timer);
        if (Date.now() < navLock.current) return;   // 이동 중: 목적지는 commitPage가 이미 저장함
        setCurrent(page);
        timer = window.setTimeout(() => {
          actions.last(lectureId, page);
          history.replaceState(null, "", `#/${course}/${lectureId}?p=${page}`);
        }, 1000);
      });
    };
    // 폰트·이미지 로드, 접기, 너비 조절로 줄 높이가 바뀌어도 다시 계산
    const ro = new ResizeObserver(onScroll);
    if (streamRef.current) ro.observe(streamRef.current);
    addEventListener("scroll", onScroll, { passive: true });
    return () => { ro.disconnect(); removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [data, items, actions, course, lectureId]);

  // 키보드: j/k 슬라이드 이동, f 책갈피, s 별표, d 필기하기, i 필기 보이기, 1/2/3 보기 방식. 한글 자판 상태의 자모도 받음
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || zoom !== null || isTyping(e.target) || overlayOpen() || document.body.dataset.agentOverlay) return;
      const rows = [...(streamRef.current?.querySelectorAll<HTMLElement>(".slide[data-page]") ?? [])];
      const pageOf = (el: HTMLElement) => Number(el.dataset.page);
      const key = e.key.toLowerCase();
      const go = (el?: HTMLElement) => {
        if (!el) return;
        commitPage(pageOf(el));
        el.scrollIntoView({ block: "start", behavior: "smooth" });
      };
      if (key === "j" || key === "ㅓ") go(rows.find((el) => pageOf(el) > current));
      else if (key === "k" || key === "ㅏ") go(rows.findLast((el) => pageOf(el) < current) ?? rows[0]);
      else if (key === "f" || key === "ㄹ") flag(current, !flagged.has(current));
      else if (key === "s" || key === "ㄴ") star(current, !starred.has(current));
      else if (key === "d" || key === "ㅇ") onDraw(current);
      else if ((key === "i" || key === "ㅑ") && hasInk) toggleInk();
      else if ((key === "p" || key === "ㅔ") && hasPrev) togglePrev();
      else { const m = MODES.find((x) => x.key === key); if (m) changeMode(m.id); else return; }
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [current, flagged, flag, starred, star, onDraw, hasInk, toggleInk, hasPrev, togglePrev, changeMode, zoom, commitPage]);

  // 크게 보기 목록은 강의의 모든 쪽. 닫을 때 넘겨 본 쪽으로 화면도 옮김
  const zoomItems = useMemo<ZoomItem[]>(() => (data?.pages ?? []).map((p) => {
    const variant = showVariant(p, inkOn, prevOn);
    return {
      src: slideUrl(course, lectureId, p.page, variant),
      id: `${lectureId}-${p.page}`,
      label: `p.${p.page}  ${plainText(pack?.slides[p.page - 1]?.title)}`,
      ink: { course, lecture: lectureId, page: p.page, base: inkBase(variant) },
    };
  }), [data, pack, inkOn, prevOn, course, lectureId]);
  const zoomStart = useRef<number | null>(null);
  if (zoom !== null && zoomStart.current === null) zoomStart.current = zoom;
  const closeZoom = useCallback(() => {
    if (zoom !== null && zoom !== zoomStart.current) scrollToPage(zoom + 1, false);
    zoomStart.current = null;
    setZoom(null);
    setDrawing(false);
  }, [zoom, scrollToPage]);

  // 브라우저 탭 제목에 지금 강의를 보여 줌
  useEffect(() => {
    if (!data) return;
    document.title = `${data.info.week} ${data.info.title} | LessonViewer`;
    return () => { document.title = "LessonViewer"; };
  }, [data]);

  if (error) return <section className="app-state" role="alert"><h1>강의를 불러오지 못했어요</h1><p>{error}</p><button onClick={load}>다시 시도</button></section>;
  if (!data) return <Loading />;

  const { info } = data;
  const at = lectures.findIndex((l) => l.id === lectureId);
  const prev = lectures[at - 1], next = lectures[at + 1];
  const beat = pack && beatNow > 0 ? pack.story[beatNow - 1] : null;

  const renderSlide = (page: number) => (
    <SlideRow key={page} course={course} lecture={lectureId} page={page} slide={pack?.slides[page - 1] ?? null}
      aspect={data.aspect} variant={showVariant(data.pages[page - 1], inkOn, prevOn)} prev={data.pages[page - 1]?.prev} inkOld={!!data.pages[page - 1]?.inkOld}
      flagged={flagged.has(page)} starred={starred.has(page)} inkVisible={inkOn} split={split.handlers} review={data.review?.[page]}
      onFlag={flag} onStar={star} onZoom={onZoom} onDraw={onDraw} cells={cellsByPage.get(page)} />
  );

  return (
    <div className={`lecture${agentOpen ? " with-agent" : ""}`} ref={split.hostRef} style={split.style}>
      <ToolbarSlot>
        <span className="where" title={`${info.week} ${info.title}`}>{info.week}<b>{info.title}</b></span>
        {pack && (
          <Popover label="이야기 목차" trigger={({ open, toggle }) => (
            <button className="beat-now" onClick={toggle} aria-expanded={open} title="이야기 목차">
              {beat && <span className="n">{beatNow}</span>}
              <span className="t">{beat ? <Inline text={beat.title} /> : "이야기 목차"}</span>
              <IconChevron />
            </button>
          )}>
            {(close) => (
              <div className="beat-menu">
                <p className="pop-label"><Inline text={pack.question} /></p>
                <ol>
                  {pack.story.map((b, i) => (
                    <li key={b.id}>
                      <button aria-current={i + 1 === beatNow ? "step" : undefined}
                        onClick={() => { close(); jumpTo(`beat-${b.id}`); }}>
                        <span className="n">{i + 1}</span>
                        <span className="t"><Inline text={b.title} /></span>
                        <span className="r">{beatRange(b)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </Popover>
        )}
        <span className="spacer" />
        <Segmented label="보기 방식" value={mode} onChange={changeMode} options={MODES} />
        {hasInk && (
          <button className={`chip${inkOn ? " on" : ""}`} aria-pressed={inkOn} onClick={toggleInk} title="내 필기 켜고 끄기 (i)">내 필기</button>
        )}
        {hasPrev && (
          <button className={`chip${prevOn ? " on" : ""}`} aria-pressed={prevOn} onClick={togglePrev} title="내용이 같은 쪽은 작년 슬라이드로 보기 (p)">작년 자료</button>
        )}
        <span className="pageno">{current} / {pageCount}</span>
        <button ref={agentButton} className="agent-toggle" aria-expanded={agentOpen} aria-controls="lecture-agent"
          onClick={() => { holdReadingPosition(); setAgentMounted(true); setAgentOpen((value) => !value); }}>학습 에이전트</button>
        <span className="progress" aria-hidden="true" style={{ transform: `scaleX(${pageCount ? current / pageCount : 0})` }} />
      </ToolbarSlot>

      <header className="lecture-head">
        <p className="week">{info.week}</p>
        <h1>{info.title}</h1>
        {pack ? (
          <>
            <p className="question"><Inline text={pack.question} /></p>
            {lab && <LabBar course={course} lecture={lectureId} lab={lab} />}
            <ol className="storymap">
              {pack.story.map((b) => (
                <li key={b.id}>
                  <button onClick={() => jumpTo(`beat-${b.id}`)}>
                    <span className="t"><Inline text={b.title} /></span>
                    <span className="r">{beatRange(b)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="waiting">아직 저장된 해설이 없어요. 원본을 읽거나 학습 에이전트에 이 자료를 질문할 수 있어요.</p>
        )}
      </header>

      <div className="stream" ref={streamRef}>
        <motion.span className="thread" aria-hidden="true" initial={{ scaleY: 0 }} animate={{ scaleY: 1 }}
          transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }} />
        {items.map((it) => {
          if (it.kind === "beat") return <BeatBlock key={`b-${it.beat.id}`} beat={it.beat} index={it.index} />;
          if (it.kind === "slide") return renderSlide(it.page);
          const open = it.pages.some((p) => expanded.has(p));
          const titles = it.pages.map((p) => plainText(pack?.slides[p - 1]?.title)).filter(Boolean);
          return (
            <div key={`f-${it.pages[0]}`} className={`fold${open ? " open" : ""}`}>
              <button className="fold-bar" onClick={() => toggleFold(it.pages)} aria-expanded={open}>
                <span className="fold-count">{open ? "다시 접기" : `접은 슬라이드 ${it.pages.length}장`}</span>
                <span className="fold-range">{range(it.pages)}</span>
                {!open && <span className="fold-titles">{titles.join(", ")}</span>}
              </button>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div className="fold-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.32, ease: [0.3, 0.7, 0.2, 1] }}>
                    {it.pages.map(renderSlide)}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {(prev || next) && (
        <nav className="lecture-nav" aria-label="다른 강의">
          {prev && <a className="prev" href={href.lecture(course, prev.id)}><span>이전 강의</span><b>{prev.week} {prev.title}</b></a>}
          {next && <a className="next" href={href.lecture(course, next.id)}><span>다음 강의</span><b>{next.week} {next.title}</b></a>}
        </nav>
      )}

      {agentMounted && <>
        {agentOpen && compactAgent && <div className="agent-backdrop" aria-hidden="true" onClick={closeAgent} />}
        <aside id="lecture-agent" ref={agentDock} className="lecture-agent-dock" tabIndex={-1} hidden={!agentOpen} inert={!agentOpen}
          role={compactAgent ? "dialog" : "complementary"} aria-modal={agentOpen && compactAgent || undefined} aria-label="학습 에이전트">
          <AgentPanel source={source} title={`${info.week} ${info.title}`} page={current}
            onNavigate={(page) => { if (compactAgent) closeAgent(); scrollToPage(page, false); }} onClose={closeAgent} />
        </aside>
      </>}
      <Lightbox items={zoomItems} index={zoom} onIndex={setZoom} onClose={closeZoom} drawing={drawing} onDrawing={setDrawing} inkVisible={inkOn} />
    </div>
  );
});
