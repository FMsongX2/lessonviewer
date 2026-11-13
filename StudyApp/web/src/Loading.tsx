// 무거운 강의(수식 수천 개)를 여는 동안 보여 줌. 0.25초 안에 끝나면 보이지 않게 CSS에서 늦게 나타남
export function Loading({ label = "불러오는 중" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-thread" aria-hidden="true" />
      {label}
    </div>
  );
}
