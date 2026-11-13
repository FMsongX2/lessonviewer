import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { CourseInfo, Progress } from "../../shared/types";
import { api } from "./api";
import { href, useRoute, type Route } from "./route";
import { Sidebar } from "./Sidebar";
import { LectureView } from "./LectureView";
import { CourseHome } from "./CourseHome";
import { Review } from "./Review";
import { Dashboard } from "./Dashboard";
import { Search } from "./Search";
import { Help, Settings, SlotContext, ThemeToggle, type TextSize, type Theme } from "./Toolbar";
import { applyThemeAttr, themeButtonCenter, withReveal, type Point } from "./theme";
import { IconKeyboard, IconSearch, IconSidebar } from "./icons";
import { isTyping, useMedia, usePref } from "./prefs";
import { holdReadingPosition } from "./anchor";
import { ModuleLibrary } from "./ModuleLibrary";
import { ModuleDocumentView } from "./ModuleDocumentView";
import { Loading } from "./Loading";
import "./module.css";
import { useWrites, type PendingWrites } from "./useWrites";
import { moduleApi } from "./moduleApi";

export type Actions = {
  seen: (lecture: string, pages: number[]) => void;
  flag: (lecture: string, page: number, flagged: boolean) => void;
  star: (lecture: string, page: number, starred: boolean) => void;
  last: (lecture: string, page: number) => void;
};

const TEXT_SCALE: Record<TextSize, number> = { s: 0.92, m: 1, l: 1.1 };

export function App() {
  const route = useRoute();
  const writes = useWrites();
  useEffect(() => {
    if (!writes.failedCount) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [writes.failedCount]);
  return <>
    {route.view === "library" || route.view === "document" ? <ModuleShell route={route} /> : <LocalApp route={route} writes={writes} />}
    {writes.failedCount > 0 && <div className="save-warning global-save-warning" role="alert">
      <span>학습 기록 {writes.failedCount}건을 저장하지 못했어요. 앱을 닫기 전에 다시 저장해 주세요.</span>
      <button onClick={writes.retry}>다시 저장</button>
    </div>}
  </>;
}

function ModuleShell({ route }: { route: Extract<Route, { view: "library" | "document" }> }) {
  const [theme, setTheme] = usePref<Theme>("theme", "system");
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const embedded = new URLSearchParams(location.search).get("embed") === "1";
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [local, setLocal] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    moduleApi.status(ac.signal).then((status) => setLocal(status.mode === "local"), () => {});
    return () => ac.abort();
  }, []);
  useEffect(() => {
    const bridge = { setTheme };
    window.lessonViewer = bridge;
    return () => { if (window.lessonViewer === bridge) delete window.lessonViewer; };
  }, [setTheme]);
  useLayoutEffect(() => applyThemeAttr(theme), [theme]);
  useEffect(() => { document.title = "자료 관리 | LessonViewer"; scrollTo(0, 0); }, [route.view, route.view === "document" ? route.documentId : ""]);
  return <div className={`module-shell${embedded ? " embedded" : ""}`}>
    <a className="skip-link" href="#module-main" onClick={(event) => { event.preventDefault(); document.getElementById("module-main")?.focus(); }}>본문으로 이동</a>
    {!embedded && <nav className="module-rail" aria-label="학습 모듈 탐색">
      <a className="module-brand" href={href.library()}>LessonViewer</a>
      {local && <a href={href.dashboard()}>내 학습</a>}
      <a href={href.library()} aria-current={route.view === "library" ? "page" : undefined}>자료 관리</a>
      <p>원본을 읽고, 해설을 검토하고,<br />궁금한 부분을 질문해 보세요.</p>
    </nav>}
    <div className="module-main">
      <header className="module-topbar">
        {route.view === "document" && <a href={href.library()}>자료 관리</a>}<div className="slot" ref={setSlot} />
        <ThemeToggle dark={theme === "dark" || (theme === "system" && systemDark)}
          onToggle={() => setTheme(theme === "dark" || (theme === "system" && systemDark) ? "light" : "dark")} />
      </header>
      <main id="module-main" tabIndex={-1}><SlotContext.Provider value={slot}>
        {route.view === "library" ? <ModuleLibrary /> : <ModuleDocumentView key={route.documentId} documentId={route.documentId} jobId={route.jobId} />}
      </SlotContext.Provider></main>
    </div>
  </div>;
}

function LocalApp({ route, writes }: { route: Exclude<Route, { view: "library" | "document" }>; writes: PendingWrites }) {
  const [courses, setCourses] = useState<CourseInfo[] | null>(null);
  const [loaded, setLoaded] = useState<Progress | null>(null);   // 진도를 받기 전엔 null
  const progress = loaded ?? {};
  const [error, setError] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const { persist } = writes;
  const [lastCourse, setLastCourse] = usePref<string | null>("course", null);
  const courseId = route.course ?? (courses?.some((c) => c.id === lastCourse) ? lastCourse! : courses?.[0]?.id);
  const course = courses?.find((c) => c.id === courseId);

  // 목록: 넓은 화면에서는 접는 열, 좁은 화면에서는 위에 덮이는 서랍
  const narrow = useMedia("(max-width: 880px)");
  const [sidePref, setSidePref] = usePref("side", true);
  const [drawer, setDrawer] = useState(false);
  const sideOpen = narrow ? drawer : sidePref;
  const toggleSide = useCallback(() => {
    if (narrow) { setDrawer((v) => !v); return; }
    holdReadingPosition();
    setSidePref((v) => !v);
  }, [narrow, setSidePref]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [theme, setTheme] = usePref<Theme>("theme", "system");
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const changeTheme = useCallback((next: Theme, from?: Point) => withReveal(() => setTheme(next), from), [setTheme]);
  const toggleTheme = useCallback((from?: Point) => changeTheme(dark ? "light" : "dark", from), [changeTheme, dark]);
  const [text, setTextPref] = usePref<TextSize>("text", "m");
  const setText = useCallback((t: TextSize) => { holdReadingPosition(); setTextPref(t); }, [setTextPref]);

  // 밝기 전환 애니메이션이 새 화면을 찍기 전에 속성이 바뀌어 있어야 해서 layout effect로 씀
  useLayoutEffect(() => applyThemeAttr(theme), [theme]);
  // LessonViewer 앱의 보기 > 화면 밝기 메뉴가 부르는 입구
  useEffect(() => {
    const bridge = { setTheme: (t: Theme) => changeTheme(t) };
    window.lessonViewer = bridge;
    return () => { if (window.lessonViewer === bridge) delete window.lessonViewer; };
  }, [changeTheme]);
  useEffect(() => { document.documentElement.style.setProperty("--ts", String(TEXT_SCALE[text])); }, [text]);
  // 덮개 창이 열린 동안 화면 단축키(j/k 등)가 뒤에서 움직이지 않게 표시
  useEffect(() => {
    if (searchOpen || helpOpen) document.body.dataset.overlay = "1"; else delete document.body.dataset.overlay;
  }, [searchOpen, helpOpen]);

  // 해설 pack은 생성되는 대로 늘어나므로 창에 돌아올 때마다 목록을 새로 받음
  const loadCourses = useCallback(() => {
    setError(null);
    return api.courses().then(setCourses).catch(() => setError("강의 목록을 불러오지 못했어요."));
  }, []);
  useEffect(() => {
    loadCourses();
    addEventListener("focus", loadCourses);
    return () => removeEventListener("focus", loadCourses);
  }, [loadCourses]);

  // 과목이 바뀌면 그 과목 진도를 새로 받고, 다음에 열 때 이 과목부터 보이게 기억함
  const known = !!course;
  useEffect(() => {
    if (!courseId || !known) return;
    let cancelled = false;
    setProgressError(null);
    setLoaded(null);
    setLastCourse(courseId);
    api.progress(courseId).then((value) => { if (!cancelled) setLoaded(value); })
      .catch(() => { if (!cancelled) setProgressError("학습 진도를 불러오지 못했어요."); });
    return () => { cancelled = true; };
  }, [courseId, known, setLastCourse]);

  // 모르는 과목 주소면 첫 화면(모든 과목)으로 보냄
  useEffect(() => {
    if (courses?.length && route.course && !courses.some((c) => c.id === route.course)) location.replace(href.dashboard());
  }, [route.course, courses]);

  // 화면이 바뀌면 맨 위에서 시작하고 서랍은 닫음. 강의의 이어 보기 위치는 LectureView가 다시 잡음
  const screen = `${route.course ?? ""}/${route.view === "lecture" ? route.lecture : route.view}`;
  useEffect(() => { scrollTo(0, 0); setDrawer(false); }, [screen]);

  // 어디서나 쓰는 단축키: [ 목록, / 또는 ⌘K 검색, ? 도움말
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.body.dataset.agentOverlay) return;
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (e.code === "KeyK" || k === "k" || k === "ㅏ")) { e.preventDefault(); setSearchOpen((v) => !v); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || searchOpen || helpOpen) return;
      if (e.key === "[" || e.code === "BracketLeft") toggleSide();
      else if (k === "t" || k === "ㅅ" || e.code === "KeyT") toggleTheme(themeButtonCenter());
      else if (e.key === "/") setSearchOpen(true);
      else if (e.key === "?") setHelpOpen(true);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [toggleSide, toggleTheme, searchOpen, helpOpen]);

  const actions = useMemo<Actions>(() => {
    const update = (lecture: string, fn: (p: Progress[string]) => Progress[string]) =>
      setLoaded((prev) => ({ ...prev, [lecture]: fn(prev?.[lecture] ?? { lastPage: null, seen: [], flagged: [], starred: [] }) }));
    return {
      seen(lecture, pages) {
        if (!courseId) return;
        update(lecture, (p) => ({ ...p, seen: [...new Set([...p.seen, ...pages])] }));
        persist(`${courseId}/${lecture}/seen/${pages.join(",")}`, () => api.seen(courseId, lecture, pages));
      },
      flag(lecture, page, flagged) {
        if (!courseId) return;
        update(lecture, (p) => ({ ...p, flagged: flagged ? [...p.flagged, page] : p.flagged.filter((x) => x !== page) }));
        persist(`${courseId}/${lecture}/flag/${page}`, () => api.flag(courseId, lecture, page, flagged));
      },
      star(lecture, page, starred) {
        if (!courseId) return;
        update(lecture, (p) => ({ ...p, starred: starred ? [...p.starred, page] : p.starred.filter((x) => x !== page) }));
        persist(`${courseId}/${lecture}/star/${page}`, () => api.star(courseId, lecture, page, starred));
      },
      last(lecture, page) {
        if (!courseId) return;
        update(lecture, (p) => ({ ...p, lastPage: page, updatedAt: Date.now() }));
        persist(`${courseId}/${lecture}/last`, () => api.last(courseId, lecture, page));
      },
    };
  }, [courseId, persist]);

  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  if (error || progressError) return <main className="app-state" role="alert"><h1>학습 화면에 연결하지 못했어요</h1><p>{error || progressError}</p>
    <button onClick={() => location.reload()}>다시 연결</button><a href={href.library()}>자료 관리 열기</a></main>;
  if (!courses) return <main className="app-state"><h1>LessonViewer</h1><Loading /></main>;
  if (!course) return <main className="app-state"><h1>첫 학습 자료를 등록하세요</h1>
    <p>PDF를 등록하면 원본을 읽고 API 에이전트로 해설을 만들 수 있어요.</p><a href={href.library()}>PDF 등록하기</a></main>;

  return (
    <div className={`app ${sideOpen ? "side-open" : "side-closed"}`}>
      <a className="skip-link" href="#learning-main" onClick={(event) => { event.preventDefault(); document.getElementById("learning-main")?.focus(); }}>본문으로 이동</a>
      <Sidebar courses={courses ?? []} course={course} progress={progress} route={route} open={sideOpen} />
      <AnimatePresence>
        {narrow && sideOpen && (
          <motion.div className="side-backdrop" onClick={() => setDrawer(false)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
        )}
      </AnimatePresence>

      <main className="main" id="learning-main" tabIndex={-1}>
        <header className="toolbar">
          <button className="icon-btn" onClick={toggleSide} aria-controls="sidebar" aria-expanded={sideOpen}
            title={sideOpen ? "강의 목록 숨기기 ([)" : "강의 목록 보기 ([)"}><IconSidebar /></button>
          <div className="slot" ref={setSlot} />
          <button className="icon-btn" onClick={() => setSearchOpen(true)} aria-label="강의 검색" title="검색 (/ 또는 ⌘K)"><IconSearch /></button>
          <ThemeToggle dark={dark} onToggle={toggleTheme} />
          <Settings theme={theme} setTheme={changeTheme} text={text} setText={setText} />
          <button className="icon-btn" onClick={() => setHelpOpen(true)} aria-label="키보드 단축키" title="단축키 (?)"><IconKeyboard /></button>
        </header>
        <SlotContext.Provider value={slot}>
          {route.view === "dashboard" ? (
            <Dashboard />
          ) : route.view === "lecture" ? (
            <LectureView key={`${course.id}/${route.lecture}`} course={course.id} lectureId={route.lecture} lectures={course.lectures}
              startPage={route.page} progress={progress[route.lecture]} progressReady={loaded !== null} actions={actions} />
          ) : route.view === "review" ? (
            <Review key={route.tab} course={course} tab={route.tab} progress={progress} actions={actions} />
          ) : (
            <CourseHome course={course} progress={progress} />
          )}
        </SlotContext.Provider>
      </main>

      <Search course={course.id} courses={courses ?? []} open={searchOpen} onClose={closeSearch} />
      <Help open={helpOpen} onClose={closeHelp} />
    </div>
  );
}
