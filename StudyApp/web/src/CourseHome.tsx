import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { CourseInfo, CourseStory, Progress } from "../../shared/types";
import { api } from "./api";
import { BeatBlock } from "./BeatBlock";
import { Inline } from "./Markdown";
import { href } from "./route";
import { readRatio } from "./Sidebar";
import { ToolbarSlot } from "./Toolbar";

// 과목 전체 흐름: 강의를 가로지르는 큰 이야기(course.json)와 강의별 이야기 목차
export function CourseHome({ course, progress }: { course: CourseInfo; progress: Progress }) {
  const [story, setStory] = useState<CourseStory | null>(null);
  useEffect(() => { api.story(course.id).then(setStory).catch(() => setStory(null)); }, [course.id]);
  const byId = new Map(course.lectures.map((l) => [l.id, l]));
  // 가장 최근에 보던 강의와 쪽. 처음 쓰는 중이면 없음
  const recent = course.lectures
    .map((l) => ({ l, p: progress[l.id] }))
    .filter((x) => x.p?.updatedAt && x.p.lastPage)
    .sort((a, b) => (b.p!.updatedAt ?? 0) - (a.p!.updatedAt ?? 0))[0];

  return (
    <div className="home">
      <ToolbarSlot><span className="where"><b>{course.title} 전체 흐름</b></span></ToolbarSlot>
      <header className="lecture-head">
        <h1>{course.title}</h1>
        {story && <p className="question"><Inline text={story.question} /></p>}
        {recent && (
          <a className="resume" href={href.lecture(course.id, recent.l.id, recent.p!.lastPage ?? undefined)}>
            <span>이어 보기</span>
            <b>{recent.l.week} {recent.l.title}</b>
            <em>p.{recent.p!.lastPage} / {recent.l.pageCount}</em>
          </a>
        )}
      </header>

      {story && (
        <div className="stream">
          <motion.span className="thread" aria-hidden="true" initial={{ scaleY: 0 }} animate={{ scaleY: 1 }}
            transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }} />
          {story.story.map((b, i) => (
            <BeatBlock key={b.id} beat={b} index={i + 1}>
              <p className="beat-links">
                {b.lectures.map((id) => {
                  const l = byId.get(id);
                  return l ? <a key={id} href={href.lecture(course.id, id)}>{l.week} {l.title}</a> : null;
                })}
              </p>
            </BeatBlock>
          ))}
        </div>
      )}

      <section className="lecture-index">
        <h2>강의별 이야기</h2>
        {course.lectures.map((l) => (
          <article key={l.id} className={l.ready ? undefined : "pending"}>
            <a className="lec-title" href={href.lecture(course.id, l.id)}>
              <span className="week">{l.week}</span>
              <span className="name">{l.title}</span>
            </a>
            {l.ready ? (
              <div className="lec-body">
                <p className="question"><Inline text={l.question ?? ""} /></p>
                <ol className="beats">
                  {l.beats?.map((b) => <li key={b.id}><a href={href.lecture(course.id, l.id, b.from)}><Inline text={b.title} /></a></li>)}
                </ol>
                <span className="meter" aria-label={`${Math.round(readRatio(l, progress[l.id]?.seen) * 100)}% 읽음`}>
                  <span style={{ width: `${readRatio(l, progress[l.id]?.seen) * 100}%` }} />
                </span>
              </div>
            ) : (
              <p className="waiting">해설 준비 중</p>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
