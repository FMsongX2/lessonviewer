import { useEffect, useState } from "react";
import type { CourseOverview } from "../../shared/types";
import { api } from "./api";
import { href } from "./route";
import { ToolbarSlot } from "./Toolbar";
import { Loading } from "./Loading";

const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
export function ago(t: number) {
  const s = (t - Date.now()) / 1000;
  if (Math.abs(s) < 60) return "방금";
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: CourseOverview[] };

// 첫 화면: 가장 최근에 보던 강의로 바로 돌아가는 길과, 과목별 진행 상황
export function Dashboard() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    api.overview()
      .then((data) => { if (live) setState({ status: "ready", data }); })
      .catch((e) => { if (live) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [attempt]);

  const slot = <ToolbarSlot><span className="where"><b>내 학습</b></span></ToolbarSlot>;
  if (state.status === "loading") return <div className="dashboard">{slot}<Loading label="학습 현황을 불러오는 중" /></div>;
  if (state.status === "error") {
    return (
      <div className="dashboard">
        {slot}
        <section className="lecture-head state-block" role="alert">
          <h1>학습 현황을 불러오지 못했어요</h1>
          <p className="state-text">과목 목록과 진도를 서버에서 받지 못했어요. 저장된 진도는 그대로 남아 있어요.</p>
          <p className="state-detail">{state.message}</p>
          <div className="state-actions">
            <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>다시 불러오기</button>
            <a className="btn" href={href.library()}>자료 관리 열기</a>
          </div>
        </section>
      </div>
    );
  }

  const data = state.data;
  if (!data.length) {
    return (
      <div className="dashboard">
        {slot}
        <section className="lecture-head state-block">
          <h1>아직 학습할 과목이 없어요</h1>
          <p className="state-text">자료 관리에서 PDF를 등록하면 원본과 해설을 이어서 읽을 수 있어요.</p>
          <div className="state-actions"><a className="btn primary" href={href.library()}>PDF 등록하기</a></div>
        </section>
      </div>
    );
  }

  const recent = data.filter((c) => c.last).sort((a, b) => b.last!.updatedAt - a.last!.updatedAt);
  const [latest, ...others] = recent;

  return (
    <div className="dashboard">
      {slot}
      <header className="lecture-head">
        <h1>{latest ? "이어서 공부하기" : "내 학습"}</h1>
        {!latest && <p className="question">과목을 고르면 강의 슬라이드와 해설을 이야기 흐름대로 이어서 읽을 수 있어요.</p>}
        {latest?.last && (
          <a className="resume big" href={href.lecture(latest.id, latest.last.lecture, latest.last.page)}>
            <span>{latest.title}</span>
            <b>{latest.last.week} {latest.last.title}</b>
            <em>{latest.last.page}쪽 / {latest.last.pageCount}쪽, {ago(latest.last.updatedAt)}</em>
          </a>
        )}
        {others.length > 0 && (
          <ul className="recent" aria-label="최근 본 다른 과목">
            {others.slice(0, 4).map((c) => (
              <li key={c.id}>
                <a href={href.lecture(c.id, c.last!.lecture, c.last!.page)}>
                  <span className="c">{c.title}</span>
                  <span className="l">{c.last!.week} {c.last!.title}</span>
                  <span className="t">{ago(c.last!.updatedAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </header>

      <section className="course-list" aria-labelledby="course-list-title">
        <h2 id="course-list-title">과목</h2>
        {data.map((c) => {
          const ratio = c.openSlides ? c.seenSlides / c.openSlides : 0;
          const pct = Math.round(ratio * 100);
          return (
            <article key={c.id}>
              <a className="name" href={href.home(c.id)}>{c.title}</a>
              {c.openSlides > 0 ? (
                <div className="progress-line">
                  <span className="meter" role="img" aria-label={`${c.openSlides}장 중 ${c.seenSlides}장 읽음`}><span style={{ width: `${ratio * 100}%` }} /></span>
                  <span className="pct">{c.seenSlides}/{c.openSlides}장</span>
                </div>
              ) : (
                <p className="progress-line none">읽을 해설이 아직 없어요</p>
              )}
              <p className="stats">
                <span>강의 {c.lectures}개{c.ready < c.lectures && `, 해설 ${c.ready}개 준비`}</span>
                {c.flagged > 0 && <a href={href.review(c.id)}>다시 볼 슬라이드 {c.flagged}장</a>}
                {c.review > 0 && <a href={href.review(c.id, "check")}>확인 필요 {c.review}장</a>}
                {c.last && <span className="when">{ago(c.last.updatedAt)} 공부함</span>}
              </p>
            </article>
          );
        })}
      </section>
    </div>
  );
}
