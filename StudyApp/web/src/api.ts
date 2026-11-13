import type { CourseInfo, CourseOverview, CourseStory, InkBase, InkStrokes, Lab, LectureData, Progress, RunResult, SearchEntry } from "../../shared/types";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function send(method: "POST" | "PUT", url: string, body: unknown, keepalive = false) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-StudyApp": "1" }, body: JSON.stringify(body), keepalive });
  if (!response.ok) throw new Error(`저장 요청에 실패했어요 (${response.status}).`);
  return response;
}

// 코드 실행 요청. 서버는 이 헤더가 붙은, 이 Mac에서 온 요청만 받음(server/index.ts trusted)
async function lab<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-StudyApp": "1" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `${res.status}`);
  return data as T;
}

export const api = {
  courses: () => get<CourseInfo[]>("/api/courses"),
  overview: () => get<CourseOverview[]>("/api/overview"),
  story: (course: string) => get<CourseStory | null>(`/api/courses/${course}/story`),
  lecture: (course: string, lecture: string) => get<LectureData>(`/api/lectures/${course}/${lecture}`),
  progress: (course: string) => get<Progress>(`/api/progress/${course}`),
  search: (course: string) => get<SearchEntry[]>(`/api/search/${course}`),
  seen: (course: string, lecture: string, pages: number[]) => send("POST", `/api/progress/${course}/${lecture}/seen`, { pages }),
  flag: (course: string, lecture: string, page: number, flagged: boolean) =>
    send("PUT", `/api/progress/${course}/${lecture}/flag`, { page, flagged }),
  star: (course: string, lecture: string, page: number, starred: boolean) =>
    send("PUT", `/api/progress/${course}/${lecture}/star`, { page, starred }),
  last: (course: string, lecture: string, page: number) => send("PUT", `/api/progress/${course}/${lecture}/last`, { page }),
  ink: (course: string, lecture: string) => get<Record<string, InkStrokes>>(`/api/ink/${course}/${lecture}`),
  // 창을 닫는 중에도 끝까지 보내도록 keepalive (본문 64KB 이하일 때만 브라우저가 허용해서 그때만 씀)
  saveInk: async (course: string, lecture: string, page: number, base: InkBase, strokes: InkStrokes, closing = false) => {
    const body = { page, base, strokes };
    const res = await send("PUT", `/api/ink/${course}/${lecture}`, body, closing && JSON.stringify(body).length < 60_000);
    if (!res.ok) throw new Error(`${res.status}`);
  },
  lab: (course: string, lecture: string) => get<Lab | null>(`/api/labs/${course}/${lecture}`),
  run: (course: string, lecture: string, cell: number, code?: string) => lab<RunResult>(`/api/labs/${course}/${lecture}/run`, { cell, code }),
  resetLab: (course: string, lecture: string) => lab<{ ok: boolean }>(`/api/labs/${course}/${lecture}/reset`),
  notebook: (course: string, lecture: string) => lab<{ ok: boolean; path: string }>(`/api/labs/${course}/${lecture}/notebook`),
};

export type SlideVariant = "clean" | "ink" | "prev";
// 이 쪽에서 기본으로 보여 줄 이미지: 내 필기 > 작년 자료(짝이 있는 쪽. 올해 자료가 부정확해서 바뀐 쪽도 작년이 기준) > 올해 원본
export const showVariant = (p: LectureData["pages"][number] | undefined, inkOn: boolean, prevOn: boolean): SlideVariant =>
  inkOn && p?.ink ? "ink" : prevOn && p?.prev?.page ? "prev" : "clean";
export const slideUrl = (course: string, lecture: string, page: number, variant: SlideVariant) =>
  `/slides/${course}/${lecture}/${variant}/${String(page).padStart(3, "0")}.jpg`;
