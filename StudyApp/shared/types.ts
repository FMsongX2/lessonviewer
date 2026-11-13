// 서버와 화면이 같이 쓰는 데이터 모양. 해설 pack 스키마는 content/GUIDE.md 와 같음.

export type Tag = "core" | "support" | "background" | "meta";

export interface Beat {
  id: string;
  from: number;
  to: number;
  title: string;
  problem: string;
  answer: string;
  tradeoff?: string;
  extra?: string;
  bridge?: string;
}

export interface Slide {
  page: number;
  tag: Tag;
  title: string;
  explain: string;
}

export interface Pack {
  lecture: string;
  question: string;
  story: Beat[];
  slides: Slide[];
}

export type Group = "summary" | "lecture" | "practice" | "recap" | "extra";

export interface LectureInfo {
  id: string;
  group: Group;
  week: string;
  title: string;
  pageCount: number;
  ready: boolean;                       // 해설 pack이 있는지
  counts: Record<Tag, number>;
  tags: Tag[];                          // 페이지 순서대로. pack이 없으면 빈 배열
  question?: string;
  beats?: { id: string; title: string; from: number }[];
  reviewCount: number;                  // '확인 필요' 쪽 수
}

export interface CourseInfo {
  id: string;
  title: string;
  lectures: LectureInfo[];
}

export interface CourseBeat {
  id: string;
  lectures: string[];
  title: string;
  problem: string;
  answer: string;
  tradeoff?: string;
  extra?: string;
  bridge?: string;
}

export interface CourseStory {
  question: string;
  story: CourseBeat[];
}

// 작년 자료와의 짝 (content/<course>/prev.json). same·changed는 page가 있고, new(올해 추가)는 없음
export interface PrevInfo {
  kind: "same" | "changed" | "new";
  page?: number;          // 작년 자료의 쪽 번호
  diff?: string;          // 올해 달라진 점 (유미 말투)
}

export interface LectureData {
  course: string;
  info: LectureInfo;
  pages: { page: number; ink: boolean; inkOld?: boolean; prev?: PrevInfo }[];   // inkOld: 필기를 이전 판 위에 썼음(courses.json inkFile)
  aspect: number;                       // width / height
  pack: Pack | null;
  review: Record<string, string>;       // 쪽 번호 → 해설 담당이 확신이 낮다고 남긴 이유 (content/<course>/review.json)
}

export type LectureProgress = { lastPage: number | null; updatedAt?: number | null; seen: number[]; flagged: number[]; starred: number[] };
export type Progress = Record<string, LectureProgress>;

// 앱에서 슬라이드 위에 직접 쓴 필기의 한 획.
//   t: pen(펜) | hl(형광펜), c: 색, w: 굵기(이미지 너비의 1/1000 단위), sim: 압력 정보가 없는 입력(마우스·트랙패드)이라 속도로 흉내 냄
//   p: [x, y, 압력, x, y, 압력, ...]. x·y는 이미지 너비·높이에 대한 0~1 비율이라 보이는 크기가 달라도 같은 자리에 그려짐
export interface InkStroke { t: "pen" | "hl"; c: string; w: number; sim?: 1; p: number[] }
export type InkStrokes = InkStroke[];
// 필기를 쓴 바탕 이미지. 작년 자료 쪽에 쓴 필기는 작년 이미지 위에서만 보임
export type InkBase = "clean" | "prev";

// 검색용 항목. 슬라이드 해설과 스토리 beat를 함께 찾음
export interface SearchEntry {
  lecture: string;
  page: number;
  kind: "slide" | "beat";
  tag?: Tag;
  title: string;
  body: string;                         // 해설 또는 beat 내용
  text: string;                         // 슬라이드 원문 텍스트
}

// 첫 화면(모든 과목) 요약
export interface CourseOverview {
  id: string;
  title: string;
  lectures: number;
  ready: number;
  openSlides: number;                   // 기본 보기에서 펼쳐지는 core·support 슬라이드 수
  seenSlides: number;                   // 그중 읽은 수
  flagged: number;
  review: number;
  last: { lecture: string; week: string; title: string; page: number; pageCount: number; updatedAt: number } | null;
}

// 해설 속 코드를 실행하는 실습 정의. content/<course>/labs/<lecture>.json (작성법은 content/LABS.md)
export type LabKernel = "sql" | "python";
export interface LabCell {
  page: number;
  block?: number;        // 그 슬라이드 해설의 몇 번째 코드 블록인지(0부터). 기본 0
  prelude?: string;      // 이 셀 바로 앞에 몰래 실행할 준비 코드(이 슬라이드만의 표·변수). 결과는 안 보임
  postlude?: string;     // 셀 뒤에 실행해 '실행 뒤' 결과로 붙일 코드(DELETE·UPDATE 뒤의 표 보여 주기)
  code?: string;         // 슬라이드 코드 그대로는 못 돌릴 때 대신 실행할 코드
  note?: string;         // 가정한 데이터나 원본과 다른 점. 셀 아래에 보여 줌
  skip?: string;         // 실행할 수 없는 이유. 있으면 실행 버튼 대신 이유를 보여 줌
  expectError?: boolean; // 오류가 나는 게 정답인 예(제약 조건 위반 등). lab-check가 오류를 통과로 봄
}
export interface Lab {
  lecture: string;
  kernel: LabKernel;
  data: string;          // 어떤 데이터를 쓰는지(진짜 데이터인지, 가정한 데이터인지)
  include?: string[];    // setup 앞에 붙일 공용 준비 코드 이름(content/<course>/labs/_shared/<이름>.sql|.py)
  setup: string;         // 실행 환경을 처음 열 때 한 번 실행(표 만들기, import, 데이터 읽기)
  isolate?: boolean;     // SQL 기본 true: 셀마다 기본 데이터에서 시작. false면 앞 셀의 변경이 이어짐
  cells: LabCell[];
}
export type RunOutput =
  | { type: "table"; columns: string[]; rows: unknown[][]; total: number | string; label?: string }
  | { type: "text"; text: string }
  | { type: "image"; png: string };
export interface RunResult { ok: boolean; stdout: string; outputs: RunOutput[]; error?: string; ms: number; ran?: number[] }
