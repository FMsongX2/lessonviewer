import type { CourseInfo, Group, LectureInfo, Progress } from "../../shared/types";
import { href, type Route } from "./route";
import { IconChevron } from "./icons";
import { Popover } from "./Toolbar";

const GROUPS: { id: Group; label: string }[] = [
  { id: "summary", label: "시험 요약" },
  { id: "lecture", label: "강의" },
  { id: "practice", label: "실습" },
  { id: "recap", label: "Recap" },
  { id: "extra", label: "보충 자료" },
];

// 읽음 비율은 기본 보기에서 펼쳐지는 core·support 슬라이드 기준
export function readRatio(lec: LectureInfo, seen: number[] = []) {
  const open = lec.tags.map((t, i) => (t === "core" || t === "support" ? i + 1 : 0)).filter(Boolean);
  if (!open.length) return 0;
  const s = new Set(seen);
  return open.filter((p) => s.has(p)).length / open.length;
}

// 읽음 표시: 선택 상태(배경·왼쪽 띠)와 헷갈리지 않게 오른쪽의 작은 원으로만 보여 줌
function ReadMark({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const label = pct >= 100 ? "다 읽음" : pct > 0 ? `${pct}% 읽음` : "아직 안 읽음";
  return (
    <span className={`read-mark${pct >= 100 ? " done" : ""}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r="6" />
        {pct > 0 && <circle className="fill" cx="8" cy="8" r="6" pathLength={100} strokeDasharray={`${pct} 100`} transform="rotate(-90 8 8)" />}
      </svg>
    </span>
  );
}

// open이 false면 접힌 상태라 탭 이동·스크린리더에서도 빠짐(inert)
type Props = { courses: CourseInfo[]; course: CourseInfo; progress: Progress; route: Route; open: boolean };

export function Sidebar({ courses, course, progress, route, open }: Props) {
  const flagged = Object.values(progress).reduce((n, p) => n + p.flagged.length, 0);
  const check = course.lectures.reduce((n, l) => n + l.reviewCount, 0);
  const active = route.view === "lecture" ? route.lecture : null;
  const inLibrary = route.view === "library" || route.view === "document";

  return (
    <nav className="sidebar" id="sidebar" aria-label="주 메뉴" inert={!open}>
      <div className="side-inner">
        <p className="brand">LessonViewer</p>
        <ul className="side-primary">
          <li><a href={href.dashboard()} aria-current={route.view === "dashboard" ? "page" : undefined}>내 학습</a></li>
          <li><a href={href.library()} aria-current={inLibrary ? "page" : undefined}>자료 관리</a></li>
        </ul>

        <section className="side-course" aria-label={`${course.title} 강의`}>
          <Popover label="과목 바꾸기" floating trigger={({ open: menuOpen, toggle }) => (
            <button className="course-title" onClick={toggle} aria-expanded={menuOpen} aria-haspopup="dialog"
              aria-label={`과목 바꾸기, 지금 과목 ${course.title}`} title="과목 바꾸기">
              <span className="t">{course.title}</span><IconChevron />
            </button>
          )}>
            {(close) => (
              <ul className="course-menu">
                <li className="all">
                  <a href={href.dashboard()} aria-current={route.view === "dashboard" ? "page" : undefined} onClick={close}>
                    <span className="t">모든 과목</span><span className="r">이어 보기</span>
                  </a>
                </li>
                {courses.map((c) => {
                  const ready = c.lectures.filter((l) => l.ready).length;
                  return (
                    <li key={c.id}>
                      <a href={href.home(c.id)} aria-current={c.id === course.id && route.view !== "dashboard" ? "page" : undefined} onClick={close}>
                        <span className="t">{c.title}</span>
                        <span className="r">{ready < c.lectures.length ? `해설 ${ready}/${c.lectures.length}` : `강의 ${c.lectures.length}개`}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Popover>
          <div className="side-links">
            <a href={href.home(course.id)} aria-current={route.view === "home" ? "page" : undefined}>전체 흐름</a>
            <a href={href.review(course.id)} aria-current={route.view === "review" && route.tab === "flagged" ? "page" : undefined}>
              다시 볼 슬라이드{flagged > 0 && <span className="count" aria-label={`${flagged}장`}>{flagged}</span>}
            </a>
            {check > 0 && (
              <a href={href.review(course.id, "check")} aria-current={route.view === "review" && route.tab === "check" ? "page" : undefined}>
                확인 필요<span className="count soft" aria-label={`${check}장`}>{check}</span>
              </a>
            )}
          </div>

          {GROUPS.map((g) => {
            const lectures = course.lectures.filter((l) => l.group === g.id);
            if (!lectures.length) return null;
            return (
              <section key={g.id} className="side-group" aria-labelledby={`side-${g.id}`}>
                <h2 id={`side-${g.id}`}>{g.label}</h2>
                <ul>
                  {lectures.map((l) => (
                    <li key={l.id}>
                      <a href={href.lecture(course.id, l.id)} aria-current={active === l.id ? "page" : undefined}
                        className={l.ready ? undefined : "pending"}>
                        <span className="week">{l.week}</span>
                        <span className="name" title={l.title}>{l.title}</span>
                        {l.ready
                          ? <ReadMark ratio={readRatio(l, progress[l.id]?.seen)} />
                          : <span className="soon">해설 준비 중</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </section>
      </div>
    </nav>
  );
}
