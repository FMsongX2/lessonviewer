// 강의 화면에서 멀리 있는 해설은 data-far로 내용을 숨기고 기억해 둔 높이(--h)만 차지함(styles.css).
// 높이는 해설이 그려져 있을 때 ResizeObserver가 계속 적어 둠. 너비·글자 크기처럼 줄 높이가 한꺼번에 바뀌면 숨긴 해설의 높이가 낡으므로,
// html.measuring으로 잠시 전부 그려 새 높이를 적게 함. ms가 지나고 한 프레임 동안 적을 높이가 더 바뀌지 않으면 다시 숨김.
// 목록 열 너비처럼 transition으로 바뀌는 중이거나 프레임이 느려 늦게 끝나도, 끝난 뒤의 높이를 적을 때까지 이어짐
let measureUntil = 0;
let measureTimer = 0;
let fontWaits = 0;
let lastRecord = 0;
export function measureAll(ms = 0) {
  const root = document.documentElement;
  root.classList.add("measuring");
  measureUntil = Math.max(measureUntil, performance.now() + ms);
  clearTimeout(measureTimer);
  measureTimer = window.setTimeout(() => requestAnimationFrame(() => {
    const mark = lastRecord;
    requestAnimationFrame(() => {
      if (performance.now() < measureUntil || fontWaits) return;
      if (lastRecord !== mark) measureAll(); else root.classList.remove("measuring");
    });
  }), measureUntil - performance.now());
}

// 강의를 처음 그리면 그 글자에 필요한 폰트(KaTeX 등)를 그때 받기 시작함. 다 올 때까지는 숨기지 않고 전부 그려 둬서
// 폰트가 바뀐 뒤의 높이를 적게 함. WebKit은 CSS 폰트의 loadingdone 이벤트를 주지 않아서 document.fonts.ready를 기다림
export function measureUntilFontsLoad() {
  fontWaits++;
  document.documentElement.classList.add("measuring");
  requestAnimationFrame(() => requestAnimationFrame(() => document.fonts.ready.then(() => {
    fontWaits--;
    measureAll();
  })));
}

let far: IntersectionObserver | undefined;
let heights: ResizeObserver | undefined;

// SlideRow의 해설 ref. 위아래로 두 화면 안에 들어오면 내용을 다시 보여 줌.
// 다시 보인 직후 WebKit은 넘치는 수식의 가로 스크롤바를 한 박자 늦게 붙여 높이가 잠깐 17px 줄었다 늘어나므로,
// 그동안(data-settling) 적어 둔 높이를 유지해 위쪽에서 펼쳐진 해설이 읽던 화면을 흔들지 않게 함
export function trackExplain(el: HTMLElement | null) {
  if (!el) return;
  if (!far || !heights) {
    far = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const target = e.target as HTMLElement;
        if (!e.isIntersecting) { target.dataset.far = ""; continue; }
        if (target.dataset.far === undefined) continue;
        delete target.dataset.far;
        target.dataset.settling = "";
        setTimeout(() => delete target.dataset.settling, 200);
      }
    }, { rootMargin: "200% 0px" });
    heights = new ResizeObserver((entries) => {
      const measuring = document.documentElement.classList.contains("measuring");
      for (const e of entries) {
        const target = e.target as HTMLElement;
        if (target.dataset.far !== undefined && !measuring) continue;
        target.style.setProperty("--h", `${e.borderBoxSize[0].blockSize}px`);
        lastRecord = performance.now();
      }
    });
    // 창 크기가 바뀌면 숨긴 해설의 높이도 바뀜
    addEventListener("resize", () => measureAll(200));
  }
  far.observe(el);
  heights.observe(el);
  return () => { far?.unobserve(el); heights?.unobserve(el); };
}

// 목록 접기·글자 크기 변경처럼 줄 높이가 한꺼번에 바뀌는 동안, 읽던 슬라이드(또는 이야기)를 화면 같은 자리에 붙잡아 둠.
// 브라우저 기본 scroll anchoring은 끄고(styles.css) 필요한 곳에서만 이걸로 맞춤
export function holdReadingPosition(ms = 480) {
  const line = 60;   // 도구줄 바로 아래
  const anchor = [...document.querySelectorAll<HTMLElement>(".slide, .beat")]
    .find((el) => el.getBoundingClientRect().bottom > line);
  // 기준 위치를 먼저 잰 뒤 숨긴 해설을 펼쳐야, 적어 둔 높이가 낡았던 위쪽 해설이 늘거나 줄어도 그만큼 되돌림
  const top = anchor?.getBoundingClientRect().top ?? 0;
  measureAll(ms);
  if (!anchor) return;
  const until = performance.now() + ms;
  // 전부 그리는 동안(최대 2초 더)은 계속 붙잡아, 늦게 끝난 너비 변화나 다시 숨길 때의 차이도 되돌림
  const tick = () => {
    const drift = anchor.getBoundingClientRect().top - top;
    if (Math.abs(drift) >= 1) scrollBy(0, drift);
    const now = performance.now();
    if (now < until || (document.documentElement.classList.contains("measuring") && now < until + 2000)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
