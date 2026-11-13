import { useEffect, useState } from "react";
import type { CourseInfo, LectureData, Progress } from "../../shared/types";
import { api, showVariant, slideUrl } from "./api";
import { inkBase } from "./inkStore";
import type { Actions } from "./App";
import { Lightbox, type ZoomItem } from "./Lightbox";
import { href, type ReviewTab } from "./route";
import { SlideRow } from "./SlideRow";
import { ToolbarSlot } from "./Toolbar";
import { useSplit } from "./useSplit";
import { plainText } from "./plain";

// 강의를 가로질러 모아 보기.
//   flagged: 오빠가 책갈피(f)로 표시한 슬라이드
//   check:   해설 담당이 확신이 낮다고 남긴 슬라이드. 원본과 대조하라고 이유를 펼쳐 둠
export function Review({ course, tab, progress, actions }: { course: CourseInfo; tab: ReviewTab; progress: Progress; actions: Actions }) {
  const flaggedCount = course.lectures.reduce((n, l) => n + (progress[l.id]?.flagged.length ?? 0), 0);
  const checkCount = course.lectures.reduce((n, l) => n + l.reviewCount, 0);
  const lectures = tab === "flagged"
    ? course.lectures.filter((l) => progress[l.id]?.flagged.length)
    : course.lectures.filter((l) => l.reviewCount > 0);
  const ids = lectures.map((l) => l.id).join(",");
  const [data, setData] = useState<Record<string, LectureData>>({});
  const [zoom, setZoom] = useState<number | null>(null);
  const [drawing, setDrawing] = useState(false);
  const split = useSplit();

  useEffect(() => {
    Promise.all(lectures.map((l) => api.lecture(course.id, l.id)))
      .then((all) => setData(Object.fromEntries(all.map((d) => [d.info.id, d]))));
  }, [course.id, ids]);

  const pagesOf = (lecture: string, d?: LectureData) => tab === "flagged"
    ? [...(progress[lecture]?.flagged ?? [])].sort((a, b) => a - b)
    : Object.keys(d?.review ?? {}).map(Number).sort((a, b) => a - b);

  // 화면에 보이는 순서대로 크게 보기 목록을 만듦
  const groups = lectures.map((l) => ({ l, d: data[l.id], pages: pagesOf(l.id, data[l.id]) }));
  const zoomItems: ZoomItem[] = groups.flatMap(({ l, d, pages }) => (d ? pages.map((page) => {
    const variant = showVariant(d.pages[page - 1], true, true);
    return {
      src: slideUrl(course.id, l.id, page, variant),
      id: `${l.id}-${page}`,
      label: `${l.week} p.${page}  ${plainText(d.pack?.slides[page - 1]?.title)}`,
      ink: { course: course.id, lecture: l.id, page, base: inkBase(variant) },
    };
  }) : []));
  const zoomAt = (lecture: string, page: number, draw: boolean) => {
    setDrawing(draw);
    setZoom(zoomItems.findIndex((z) => z.id === `${lecture}-${page}`));
  };
  const flaggedSet = (lecture: string) => new Set(progress[lecture]?.flagged);
  const starredSet = (lecture: string) => new Set(progress[lecture]?.starred);

  return (
    <div className="review" ref={split.hostRef} style={split.style}>
      <ToolbarSlot><span className="where"><b>{tab === "flagged" ? `다시 볼 슬라이드 ${flaggedCount}장` : `확인 필요 ${checkCount}장`}</b></span></ToolbarSlot>
      <header className="lecture-head">
        <h1>모아 보기</h1>
        <nav className="tabs" aria-label="모아 보기 종류">
          <a href={href.review(course.id)} aria-current={tab === "flagged" ? "page" : undefined}>책갈피 <span>{flaggedCount}</span></a>
          <a href={href.review(course.id, "check")} aria-current={tab === "check" ? "page" : undefined}>확인 필요 <span>{checkCount}</span></a>
        </nav>
        {tab === "flagged" && !lectures.length && (
          <p className="question">아직 표시한 슬라이드가 없어. 강의 보다가 쪽 번호 아래 책갈피를 누르거나 <kbd>f</kbd>를 누르면 여기 모여!</p>
        )}
        {tab === "check" && (
          <p className="question">
            {checkCount
              ? "유미가 해설 쓰면서 확신이 낮았던 쪽이야. 그래프를 눈으로 읽은 값, 알아보기 힘든 필기, 슬라이드 자체 오타 같은 데라서 원본 슬라이드랑 같이 확인해 줘!"
              : "이 과목엔 확인이 필요한 쪽이 없어."}
          </p>
        )}
      </header>
      {groups.map(({ l, d, pages }) => d && (
        <section key={l.id} className="review-group">
          <h2><a href={href.lecture(course.id, l.id)}>{l.week} <b>{l.title}</b></a><span className="n">{pages.length}장</span></h2>
          <div className="stream">
            {pages.map((page) => (
              <SlideRow key={page} course={course.id} lecture={l.id} page={page} slide={d.pack?.slides[page - 1] ?? null}
                aspect={d.aspect} variant={showVariant(d.pages[page - 1], true, true)} prev={d.pages[page - 1]?.prev}
                flagged={flaggedSet(l.id).has(page)} starred={starredSet(l.id).has(page)} inkVisible split={split.handlers}
                review={d.review?.[page]} reviewOpen={tab === "check"}
                onFlag={(p, on) => actions.flag(l.id, p, on)} onStar={(p, on) => actions.star(l.id, p, on)}
                onZoom={(p) => zoomAt(l.id, p, false)} onDraw={(p) => zoomAt(l.id, p, true)} />
            ))}
          </div>
        </section>
      ))}
      <Lightbox items={zoomItems} index={zoom} onIndex={setZoom} onClose={() => { setZoom(null); setDrawing(false); }}
        drawing={drawing} onDrawing={setDrawing} />
    </div>
  );
}
