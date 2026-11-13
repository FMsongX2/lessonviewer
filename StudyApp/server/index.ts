// 시험공부 앱 서버. 해설 pack·슬라이드 이미지·진도 API를 주고, 빌드된 화면(dist)도 함께 서빙함.
// 실행: bun server/index.ts  (PORT 기본 5178, 기본은 이 컴퓨터(127.0.0.1·::1)에서만 받음)
// 기존 강의·진도·실습 API는 이 컴퓨터에서 온 요청만 받고, 외부 호스트는 /api/module 만 토큰으로 씀(server/module/README.md)

import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { authenticate, isLocalRequest } from "./module/auth";
import { loadModuleConfig } from "./module/config";
import { createModule } from "./module/index";
import { openDb } from "./db";
import { buildNotebook, loadLab, openInEditor, resetLab, runCell, stopAll } from "./labs";
import type { CourseInfo, CourseOverview, CourseStory, InkStroke, LectureData, LectureInfo, Pack, SearchEntry, Tag } from "../shared/types";

const APP = join(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 5178);
// courses.json은 과목을 추가할 때 바뀌므로 수정 시각이 달라지면 다시 읽음
const CONFIG_PATH = join(APP, "courses.json");
let configCache: { mtime: number; courses: CourseConfig[] } | null = null;
function courses(): CourseConfig[] {
  const mtime = statSync(CONFIG_PATH).mtimeMs;
  if (configCache?.mtime !== mtime) configCache = { mtime, courses: JSON.parse(readFileSync(CONFIG_PATH, "utf8")).courses };
  return configCache.courses;
}
// LESSONVIEWER_STUDY_DB: 시험용으로 진도 DB만 다른 곳에 둘 때(강의 자료는 그대로 읽기만 함)
const db = openDb(process.env.LESSONVIEWER_STUDY_DB?.trim() || join(APP, "data", "study.db"));
const ID = /^[a-z0-9-]+$/;

type LectureConfig = { id: string; group: LectureInfo["group"]; week: string; title: string; file: string };
type CourseConfig = { id: string; title: string; dir: string; lectures: LectureConfig[] };

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// pack은 생성 중에도 바뀌므로 요청마다 다시 읽음. 파일이 작아 비용이 거의 없음
function loadPack(course: string, lecture: string) {
  try { return readJson<Pack>(join(APP, "content", course, `${lecture}.json`)); }
  catch { return null; }   // 작성 중인 반쪽 파일
}

function loadExtract(course: string, lecture: string) {
  return readJson<{ pageCount: number; width: number; height: number; pages: { page: number; ink: boolean; text: string; inkFrom?: string }[] }>(
    join(APP, "data", "extract", course, `${lecture}.json`));
}

// 올해 쪽 → 작년 자료 쪽 짝. 요청마다 읽음(scripts/prev-map.py, prev-merge.ts 가 만듦)
type PrevPage = { page: number | null; kind: "same" | "changed" | "new"; diff?: string };
function loadPrev(course: string, lecture: string): Record<string, PrevPage> {
  try { return readJson<Record<string, { pages: Record<string, PrevPage> }>>(join(APP, "content", course, "prev.json"))?.[lecture]?.pages ?? {}; }
  catch { return {}; }
}

function loadReview(course: string) {
  return readJson<Record<string, Record<string, string>>>(join(APP, "content", course, "review.json")) ?? {};
}

function lectureInfo(course: string, lec: LectureConfig, review = loadReview(course)): LectureInfo {
  const extract = loadExtract(course, lec.id);
  const pack = loadPack(course, lec.id);
  const counts: Record<Tag, number> = { core: 0, support: 0, background: 0, meta: 0 };
  for (const s of pack?.slides ?? []) counts[s.tag]++;
  return {
    id: lec.id, group: lec.group, week: lec.week, title: lec.title,
    pageCount: extract?.pageCount ?? 0, ready: !!pack, counts, tags: pack?.slides.map((s) => s.tag) ?? [],
    question: pack?.question, beats: pack?.story.map((b) => ({ id: b.id, title: b.title, from: b.from })),
    reviewCount: Object.keys(review[lec.id] ?? {}).length,
  };
}

function findCourse(id: string): CourseConfig | undefined {
  return courses().find((c) => c.id === id);
}

export const app = new Hono();

// 기존 API·슬라이드는 이 컴퓨터에서 직접 온 요청만. 화면 파일은 인증된 호스트 프록시(임베드)에도 줌
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (path === "/api/module" || path.startsWith("/api/module/")) return next();   // 모듈은 자체 인증
  if (!c.req.header("authorization") && isLocalRequest(c.req.raw, c.env)) return next();
  const isPrivate = path.startsWith("/api/") || path.startsWith("/slides/");
  if (!isPrivate && c.req.header("authorization") && authenticate(c.req.raw, c.env, moduleConfig.hostToken).ok) return next();
  return c.json({ error: "this endpoint is only available on this computer", code: "forbidden" }, 403);
});

// ── LessonViewer 모듈(/api/module): 문서 올리기·해설 생성·학습 대화 ──
const moduleConfig = loadModuleConfig(process.env, APP);
const lessonModule = createModule({
  config: moduleConfig,
  catalog: {
    lecture(course, lecture) {
      const c = findCourse(course);
      const lec = c?.lectures.find((l) => l.id === lecture);
      const extract = lec && loadExtract(course, lecture);
      if (!c || !lec || !extract) return null;
      return {
        title: `${c.title} · ${lec.week} ${lec.title}`,
        pages: extract.pages.map((p) => ({ page: p.page, text: p.text })),
        pack: loadPack(course, lecture),
        imagePath: (page) => join(APP, "data", "slides", course, lecture, "clean", `${String(page).padStart(3, "0")}.jpg`),
      };
    },
  },
});
app.route("/api/module", lessonModule.app);

app.get("/api/courses", (c) =>
  c.json(courses().map<CourseInfo>((course) => {
    const review = loadReview(course.id);
    return { id: course.id, title: course.title, lectures: course.lectures.map((l) => lectureInfo(course.id, l, review)) };
  })));

// 첫 화면: 과목마다 읽은 정도, 책갈피·확인 필요 수, 마지막으로 보던 강의
app.get("/api/overview", (c) =>
  c.json(courses().map<CourseOverview>((course) => {
    const progress = db.progress(course.id);
    const review = loadReview(course.id);
    let openSlides = 0, seenSlides = 0, flagged = 0, reviewCount = 0;
    let last: CourseOverview["last"] = null;
    const infos = course.lectures.map((l) => lectureInfo(course.id, l, review));
    for (const info of infos) {
      const p = progress[info.id];
      const seen = new Set(p?.seen);
      info.tags.forEach((t, i) => {
        if (t !== "core" && t !== "support") return;
        openSlides++;
        if (seen.has(i + 1)) seenSlides++;
      });
      flagged += p?.flagged.length ?? 0;
      reviewCount += info.reviewCount;
      if (p?.lastPage && p.updatedAt && (!last || p.updatedAt > last.updatedAt)) {
        last = { lecture: info.id, week: info.week, title: info.title, page: p.lastPage, pageCount: info.pageCount, updatedAt: p.updatedAt };
      }
    }
    return { id: course.id, title: course.title, lectures: infos.length, ready: infos.filter((i) => i.ready).length, openSlides, seenSlides, flagged, review: reviewCount, last };
  })));

app.get("/api/courses/:course/story", (c) => {
  const course = c.req.param("course");
  if (!ID.test(course)) return c.notFound();
  const story = readJson<CourseStory>(join(APP, "content", course, "course.json"));
  return story ? c.json(story) : c.json(null);
});

app.get("/api/lectures/:course/:lecture", (c) => {
  const { course, lecture } = c.req.param();
  const lec = findCourse(course)?.lectures.find((l) => l.id === lecture);
  const extract = lec && loadExtract(course, lecture);
  if (!lec || !extract) return c.json({ error: "강의를 찾을 수 없음. scripts/extract.py를 먼저 실행해야 함" }, 404);
  const prevMap = loadPrev(course, lecture);
  const loadPrevOnce = (page: number) => prevMap[String(page)];
  const data: LectureData = {
    course, info: lectureInfo(course, lec),
    pages: extract.pages.map((p) => {
      const pv = loadPrevOnce(p.page);
      return { page: p.page, ink: p.ink, ...(p.inkFrom ? { inkOld: true } : {}),
        ...(pv ? { prev: { kind: pv.kind, ...(pv.page ? { page: pv.page } : {}), ...(pv.diff ? { diff: pv.diff } : {}) } } : {}) };
    }),
    aspect: extract.width / extract.height,
    pack: loadPack(course, lecture),
    review: loadReview(course)[lecture] ?? {},
  };
  return c.json(data);
});

// 과목 전체 검색 자료. 화면이 한 번 받아 두고 브라우저에서 찾음
app.get("/api/search/:course", (c) => {
  const course = findCourse(c.req.param("course"));
  if (!course) return c.notFound();
  const out: SearchEntry[] = [];
  for (const lec of course.lectures) {
    const pack = loadPack(course.id, lec.id);
    const text = new Map(loadExtract(course.id, lec.id)?.pages.map((p) => [p.page, p.text]) ?? []);
    for (const b of pack?.story ?? []) {
      const body = [b.problem, b.answer, b.tradeoff, b.extra, b.bridge].filter(Boolean).join(" ");
      out.push({ lecture: lec.id, page: b.from, kind: "beat", title: b.title, body, text: "" });
    }
    for (const s of pack?.slides ?? []) {
      out.push({ lecture: lec.id, page: s.page, kind: "slide", tag: s.tag, title: s.title, body: s.explain, text: text.get(s.page) ?? "" });
    }
  }
  return c.json(out);
});

app.get("/api/progress/:course", (c) => c.json(db.progress(c.req.param("course"))));

app.post("/api/progress/:course/:lecture/seen", async (c) => {
  const { course, lecture } = c.req.param();
  const { pages } = await c.req.json<{ pages: number[] }>();
  db.markSeen(course, lecture, pages.filter(Number.isInteger));
  return c.json({ ok: true });
});

app.put("/api/progress/:course/:lecture/flag", async (c) => {
  const { course, lecture } = c.req.param();
  const { page, flagged } = await c.req.json<{ page: number; flagged: boolean }>();
  db.setFlag(course, lecture, page, flagged);
  return c.json({ ok: true });
});

app.put("/api/progress/:course/:lecture/star", async (c) => {
  const { course, lecture } = c.req.param();
  const { page, starred } = await c.req.json<{ page: number; starred: boolean }>();
  if (!Number.isInteger(page)) return c.json({ error: "page" }, 400);
  db.setStar(course, lecture, page, !!starred);
  return c.json({ ok: true });
});

app.put("/api/progress/:course/:lecture/last", async (c) => {
  const { course, lecture } = c.req.param();
  const { page } = await c.req.json<{ page: number }>();
  db.setLast(course, lecture, page);
  return c.json({ ok: true });
});

// ── 앱에서 쓴 필기 ──
app.get("/api/ink/:course/:lecture", (c) => {
  const { course, lecture } = c.req.param();
  if (!ID.test(course) || !ID.test(lecture)) return c.notFound();
  return c.json(db.ink(course, lecture));
});

// 쪽 하나의 획 전체를 바꿔 씀(빈 목록이면 지움). 모양이 맞지 않는 획은 받지 않음
const INK_LIMIT = 2_000_000;   // 쪽 하나에 이보다 큰 필기는 비정상으로 봄(빽빽한 필기도 수백 KB)
const isStroke = (s: unknown): s is InkStroke => {
  const o = s as InkStroke;
  return !!o && (o.t === "pen" || o.t === "hl") && typeof o.c === "string" && /^#[0-9a-f]{6}$/i.test(o.c)
    && typeof o.w === "number" && o.w > 0 && o.w < 200 && (o.sim === undefined || o.sim === 1)
    && Array.isArray(o.p) && o.p.length >= 3 && o.p.length % 3 === 0 && o.p.every((n) => typeof n === "number" && Number.isFinite(n));
};
app.put("/api/ink/:course/:lecture", async (c) => {
  const { course, lecture } = c.req.param();
  if (!ID.test(course) || !ID.test(lecture)) return c.notFound();
  const raw = await c.req.text();
  if (raw.length > INK_LIMIT) return c.json({ error: "필기가 너무 커" }, 413);
  const { page, base, strokes } = JSON.parse(raw) as { page: number; base: string; strokes: unknown[] };
  if (!Number.isInteger(page) || page < 1 || (base !== "clean" && base !== "prev") || !Array.isArray(strokes) || !strokes.every(isStroke)) {
    return c.json({ error: "필기 모양이 맞지 않아" }, 400);
  }
  db.setInk(course, lecture, page, base, strokes);
  return c.json({ ok: true });
});

// ── 코드 실행(server/labs.ts) ──
// 코드를 실행하는 요청은 이 Mac에서, 이 앱 화면이 보낸 것만 받음. 같은 네트워크의 다른 기기나
// 다른 웹사이트가 오빠 컴퓨터에서 코드를 돌리지 못하게 함: 루프백 주소 + Host 확인 + 사용자 정의 헤더(다른 출처는 사전 요청에서 막힘)
function trusted(c: { env: unknown; req: { raw: Request; header: (k: string) => string | undefined } }) {
  const ip = (c.env as { requestIP?: (r: Request) => { address: string } | null })?.requestIP?.(c.req.raw)?.address ?? "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const host = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(c.req.header("host") ?? "");
  return loopback && host && c.req.header("x-studyapp") === "1";
}

app.get("/api/labs/:course/:lecture", (c) => {
  const { course, lecture } = c.req.param();
  if (!ID.test(course) || !ID.test(lecture)) return c.notFound();
  const lab = loadLab(course, lecture);
  return lab ? c.json(lab) : c.json(null);
});

app.post("/api/labs/:course/:lecture/run", async (c) => {
  if (!trusted(c)) return c.json({ error: "이 Mac의 앱 화면에서만 실행할 수 있어" }, 403);
  const { course, lecture } = c.req.param();
  if (!ID.test(course) || !ID.test(lecture)) return c.notFound();
  const body = await c.req.json<{ cell: number; code?: string }>();
  return c.json(await runCell(course, lecture, Number(body.cell), typeof body.code === "string" ? body.code : undefined));
});

app.post("/api/labs/:course/:lecture/reset", (c) => {
  if (!trusted(c)) return c.json({ error: "forbidden" }, 403);
  const { course, lecture } = c.req.param();
  if (!ID.test(course) || !ID.test(lecture)) return c.notFound();
  resetLab(course, lecture);
  return c.json({ ok: true });
});

app.post("/api/labs/:course/:lecture/notebook", (c) => {
  if (!trusted(c)) return c.json({ error: "forbidden" }, 403);
  const { course, lecture } = c.req.param();
  const lec = findCourse(course)?.lectures.find((l) => l.id === lecture);
  if (!lec) return c.notFound();
  let path: string | null;
  try { path = buildNotebook(course, lecture, `${lec.week} ${lec.title}`); }
  catch (e) { return c.json({ error: String((e as Error).message) }, 500); }
  if (!path) return c.json({ error: "이 강의엔 노트북으로 만들 실습이 없어" }, 404);
  openInEditor(path);
  return c.json({ ok: true, path });
});

// 슬라이드 이미지: /slides/<course>/<lecture>/<clean|ink|prev>/<NNN>.jpg. prev는 올해 NNN쪽과 짝인 작년 자료 쪽
app.get("/slides/:course/:lecture/:variant/:file", (c) => {
  const { course, lecture, variant, file } = c.req.param();
  if (!ID.test(course) || !ID.test(lecture) || !/^(clean|ink|prev)$/.test(variant) || !/^\d{3}\.jpg$/.test(file)) return c.notFound();
  let path = join(APP, "data", "slides", course, lecture, variant, file);
  if (variant === "prev") {
    const old = loadPrev(course, lecture)[String(Number(file.slice(0, 3)))]?.page;
    if (!old) return c.notFound();
    path = join(APP, "data", "slides", course, lecture, "prevall", `${String(old).padStart(3, "0")}.jpg`);
  }
  if (!existsSync(path)) return c.notFound();
  return new Response(Bun.file(path), { headers: { "Cache-Control": "no-cache" } });
});

// 빌드된 화면. 없는 경로는 index.html (해시 라우팅이라 거의 안 쓰임)
const DIST = join(APP, "dist");
app.get("*", (c) => {
  const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^\/+/, "");
  const path = join(DIST, rel);
  // 해시가 붙은 assets는 오래 캐시하고, index.html과 나머지는 매번 확인함. 안 그러면 앱(WebKit)이 옛 화면을 띄움
  if (rel && path.startsWith(DIST + "/") && existsSync(path) && statSync(path).isFile()) {
    const cache = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(Bun.file(path), { headers: { "Cache-Control": cache } });
  }
  const index = join(DIST, "index.html");
  if (existsSync(index)) return new Response(Bun.file(index), { headers: { "Cache-Control": "no-cache" } });
  return c.text("화면이 아직 빌드되지 않았음. bun run build 를 먼저 실행해야 함", 503);
});

// 기본은 이 컴퓨터에서만 받음. localhost 가 ::1 로도 풀리므로 IPv4·IPv6 루프백 둘 다 엶.
// LESSONVIEWER_BIND=0.0.0.0 처럼 바꾸면 그 주소 하나로 엶(외부 호스트용. 그래도 모듈 외 API는 위 검사로 막힘)
if (import.meta.main) {
  const bind = process.env.LESSONVIEWER_BIND?.trim();
  for (const hostname of bind ? [bind] : ["127.0.0.1", "::1"]) {
    // maxRequestBodySize: 서버 전체 본문 상한(모듈 업로드 50MB + multipart 여유). 모듈은 따로 바이트를 세어 다시 막음
    try { Bun.serve({ hostname, port: PORT, fetch: app.fetch, idleTimeout: 255, maxRequestBodySize: 52 * 1024 * 1024 }); }
    catch (e) { if (bind || hostname === "127.0.0.1") throw e; }   // IPv6가 꺼진 컴퓨터면 ::1 은 건너뜀
  }
  // 서버가 꺼질 때 띄워 둔 코드 실행기와 모듈 작업도 같이 끔
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopAll(); lessonModule.close(); process.exit(0); });
  console.log(`LessonViewer: http://localhost:${PORT}${bind ? ` (bind ${bind})` : ""}`);
}
