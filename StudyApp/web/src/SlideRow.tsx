import { memo, useCallback, useState } from "react";
import { motion } from "motion/react";
import type { LabCell, PrevInfo, Slide, Tag } from "../../shared/types";
import { slideUrl, type SlideVariant } from "./api";
import { InkLayer } from "./Ink";
import { inkBase, useStrokes } from "./inkStore";
import { IconPen } from "./icons";
import { Inline, Markdown, type RenderBlock } from "./Markdown";
import { RunCell } from "./RunCell";
import { trackExplain } from "./anchor";

// 이 슬라이드에서 실행할 수 있는 코드 블록: 블록 번호 → 실습 셀
export type SlideCells = Map<number, { index: number; cell: LabCell }>;
import type { SplitHandlers } from "./useSplit";

export const TAG_LABEL: Record<Tag, string> = { core: "핵심", support: "보조", background: "배경", meta: "표지·목차" };

type Props = {
  course: string;
  lecture: string;
  page: number;
  slide: Slide | null;          // pack이 아직 없으면 null
  aspect: number;
  variant: SlideVariant;        // 기본으로 보여 줄 이미지(내 필기, 작년 자료, 올해 원본)
  prev?: PrevInfo;              // 작년 자료와의 짝
  inkOld?: boolean;             // 그 필기가 이전 판 슬라이드 위에 쓴 것인지
  flagged: boolean;
  starred: boolean;
  inkVisible: boolean;          // 앱에서 쓴 필기를 겹쳐 보일지(도구줄 '내 필기')
  split: SplitHandlers;
  review?: string;              // 해설이 불확실한 이유. 있으면 '확인 필요'로 펼쳐 볼 수 있음
  reviewOpen?: boolean;         // 확인 필요 모아 보기에서는 처음부터 펼침
  onFlag: (page: number, flagged: boolean) => void;
  onStar: (page: number, starred: boolean) => void;
  onZoom: (page: number) => void;
  onDraw: (page: number) => void;   // 크게 보기를 필기 모드로 엶
  cells?: SlideCells;           // 실행 환경이 있는 코드 블록
};

export const SlideRow = memo(function SlideRow({ course, lecture, page, slide, aspect, variant, prev, inkOld, flagged, starred, inkVisible, split, review, reviewOpen, onFlag, onStar, onZoom, onDraw, cells }: Props) {
  const renderBlock = useCallback<RenderBlock>((block, _lang, code, pre) => {
    const c = cells?.get(block);
    return c ? <RunCell course={course} lecture={lecture} index={c.index} cell={c.cell} original={code} pre={pre} /> : pre;
  }, [cells, course, lecture]);
  // 작년 자료와 올해 원본을 이 쪽에서만 바꿔 봄. 필기본은 올해 쪽 위에 쓴 것이라 바꾸지 않음
  const [peek, setPeek] = useState(false);
  const canPeek = variant !== "ink" && !!prev?.page;
  const shown: SlideVariant = peek && canPeek ? (variant === "prev" ? "clean" : "prev") : variant;
  const ink = shown === "ink";
  const base = inkBase(shown);
  const strokes = useStrokes({ course, lecture, page, base });
  return (
    <article className={`slide tag-${slide?.tag ?? "none"}`} id={`p-${page}`} data-page={page}>
      <div className="gutter">
        <span className="pno" aria-label={`${page}쪽`}>p.{page}</span>
        <button className={`flag${flagged ? " on" : ""}`} onClick={() => onFlag(page, !flagged)}
          aria-pressed={flagged} title={flagged ? "다시 볼 슬라이드에서 빼기 (f)" : "다시 볼 슬라이드로 표시 (f)"}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <motion.path d="M6 3.5h8a.5.5 0 0 1 .5.5v12.6L10 13.4l-4.5 3.2V4a.5.5 0 0 1 .5-.5z" fill="currentColor" stroke="currentColor"
              strokeWidth="1.6" strokeLinejoin="round" initial={false} animate={{ fillOpacity: flagged ? 1 : 0 }} transition={{ duration: 0.2 }} />
          </svg>
        </button>
        <button className={`flag star${starred ? " on" : ""}`} onClick={() => onStar(page, !starred)}
          aria-pressed={starred} title={starred ? "별표 빼기 (s)" : "별표 하기 (s)"}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <motion.path d="M10 2.9l2.15 4.47 4.9.62-3.6 3.38.93 4.86L10 13.85l-4.38 2.38.93-4.86-3.6-3.38 4.9-.62z" fill="currentColor" stroke="currentColor"
              strokeWidth="1.5" strokeLinejoin="round" initial={false} animate={{ fillOpacity: starred ? 1 : 0, scale: starred ? [1, 1.25, 1] : 1 }}
              transition={{ duration: 0.28 }} style={{ transformOrigin: "50% 55%" }} />
          </svg>
        </button>
        <button className={`flag pen${strokes.length ? " has" : ""}`} onClick={() => onDraw(page)}
          title={strokes.length ? "필기 이어 쓰기 (d)" : "이 쪽에 필기하기 (d)"} aria-label={`${page}쪽에 필기하기`}>
          <IconPen />
        </button>
        {canPeek && (
          <button className="peek" onClick={() => setPeek((v) => !v)} aria-pressed={peek}
            title={shown === "prev" ? "올해 자료 원본으로 바꿔 보기" : `작년 자료 p.${prev?.page}로 바꿔 보기`}>
            {shown === "prev" ? "올해" : "작년"}
          </button>
        )}
      </div>

      <button className="shot" onClick={() => onZoom(page)} aria-label={`${page}쪽 크게 보기`}>
        <motion.img layoutId={`${lecture}-${page}`} src={slideUrl(course, lecture, page, shown)} alt="" loading="lazy" style={{ aspectRatio: aspect }} />
        {inkVisible && strokes.length > 0 && <InkLayer strokes={strokes} aspect={aspect} />}
        {shown === "prev" && <span className="ink-badge prev-badge" title={prev?.kind === "changed" ? "올해 자료는 내용이 달라졌어. 올해 쪽은 부정확해서 작년 슬라이드를 기준으로 보여 주고, 달라진 점은 아래 상자에 적었어." : "올해 자료와 내용이 같은 작년 슬라이드야. 그림이 더 믿을 만해서 이쪽을 보여 줘."}>{prev?.kind === "changed" ? `작년 자료 p.${prev?.page} · 올해 바뀜` : `작년 자료 p.${prev?.page}`}</span>}
        {shown !== "prev" && !ink && prev?.kind === "new" && <span className="ink-badge prev-badge new">올해 추가</span>}
        {shown !== "prev" && !ink && prev?.kind === "changed" && <span className="ink-badge prev-badge new">올해 원본 · 바뀐 쪽</span>}
        {ink && <span className="ink-badge" title={inkOld ? "이전 판 슬라이드 위에 쓴 필기야. 지금 판과 내용이 조금 다를 수 있어." : undefined}>{inkOld ? "내 필기 · 이전 판" : "내 필기"}</span>}
      </button>

      <div className="splitter" role="separator" aria-orientation="vertical" aria-label="슬라이드와 해설 너비"
        aria-valuemin={28} aria-valuemax={76} aria-valuenow={Math.round(split.value * 100)} tabIndex={0}
        onPointerDown={split.start} onKeyDown={split.key} onDoubleClick={split.reset}
        title="끌어서 너비 조절, 더블클릭하면 처음 비율">
        <span className="grip" />
      </div>

      <div className="explain" ref={trackExplain}>
        {slide ? (
          <>
            <h3>
              <span><Inline text={slide.title} /></span>
              <span className={`tagname t-${slide.tag}`}>{TAG_LABEL[slide.tag]}</span>
            </h3>
            {review && (
              <details className="review" open={reviewOpen}>
                <summary title="유미가 해설 쓰면서 확신이 낮았던 데가 있어. 슬라이드랑 같이 확인해 줘!">확인 필요</summary>
                <p>{review}</p>
              </details>
            )}
            {prev?.diff && (
              <div className="diff" role="note">
                <b>{prev.kind === "new" ? "올해 추가된 내용" : "올해 달라진 점"}</b>
                <Markdown text={prev.diff} />
              </div>
            )}
            <Markdown text={slide.explain} renderBlock={cells?.size ? renderBlock : undefined} />
          </>
        ) : (
          <p className="waiting">이 강의 해설은 유미가 아직 준비하고 있어.</p>
        )}
      </div>
    </article>
  );
});
