import type { ReactNode } from "react";
import type { Beat, CourseBeat } from "../../shared/types";
import { Inline } from "./Markdown";

// 스토리 한 단계. 문제 → 해결 → trade-off → (보충) → 다음 이야기
export function BeatBlock({ beat, index, range, children }: { beat: Beat | CourseBeat; index: number; range?: string; children?: ReactNode }) {
  return (
    <section className="beat" id={`beat-${beat.id}`} data-index={index}>
      <span className="node" aria-hidden="true">{index}</span>
      <header>
        <h3><Inline text={beat.title} /></h3>
        {range && <span className="range">{range}</span>}
      </header>
      <dl>
        <dt>문제</dt>
        <dd><Inline text={beat.problem} /></dd>
        <dt>해결</dt>
        <dd><Inline text={beat.answer} /></dd>
        {beat.tradeoff && (<><dt>trade-off</dt><dd><Inline text={beat.tradeoff} /></dd></>)}
        {beat.extra && (<><dt className="extra">보충</dt><dd className="extra"><Inline text={beat.extra} /></dd></>)}
      </dl>
      {beat.bridge && <p className="bridge"><span><Inline text={beat.bridge} /></span></p>}
      {children}
    </section>
  );
}
