// content/<course>/<lecture>.json 해설 pack이 GUIDE.md 스키마를 지키는지 검사함.
// 실행: bun scripts/validate.ts [course | course/lecture ...]   인자가 없으면 전부
// 오류가 있으면 exit 1. 분량 초과는 경고만 냄.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import katex from "katex";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";

// 앱(web/src/Markdown.tsx)과 같은 설정으로 Markdown을 읽어 깨진 굵게·취소선을 찾음
const md = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkCjkFriendly);
function walkMd(n: any, f: (n: any) => void) { f(n); (n.children ?? []).forEach((c: any) => walkMd(c, f)); }

const APP = join(import.meta.dir, "..");
const config = JSON.parse(readFileSync(join(APP, "courses.json"), "utf8"));
const TAGS = new Set(["core", "support", "background", "meta"]);
const LIMIT: Record<string, number> = { core: 1100, support: 600, background: 300, meta: 120 };
const MATH = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
const RAW_FORMULA = /[σΠπρ⋈θ]_|_\{/;
const LOOSE_SYMBOL = /[σΠπρ⋈θ∧∨¬×∪∩≠]/;

const args = process.argv.slice(2);
let errors = 0, warnings = 0, checked = 0;

// 조각 검사: bun scripts/validate.ts --part <course>/<lecture> <n> <from> <to>
if (args[0] === "--part") {
  const [, target, n, from, to] = args;
  const [course, lecture] = (target ?? "").split("/");
  const key = `${target}.part${n}`;
  const path = join(APP, "content", course!, `${lecture}.part${n}.json`);
  if (!existsSync(path)) { console.log(`✗ ${key}: 파일 없음 ${path}`); process.exit(1); }
  let pack: any;
  try { pack = JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.log(`✗ ${key}: JSON 파싱 실패 ${e}`); process.exit(1); }
  validate(key, lecture!, pack, Number(to) - Number(from) + 1, Number(from), n === "1");
  console.log(`\n조각 검사 ${key} (p${from}–${to}): 오류 ${errors}, 경고 ${warnings}`);
  process.exit(errors ? 1 : 0);
}

for (const course of config.courses) {
  if (!args.length || args.includes(course.id)) validateCourseStory(course);
  for (const lec of course.lectures) {
    const key = `${course.id}/${lec.id}`;
    if (args.length && !args.includes(key) && !args.includes(course.id)) continue;
    const packPath = join(APP, "content", course.id, `${lec.id}.json`);
    const extractPath = join(APP, "data", "extract", course.id, `${lec.id}.json`);
    if (!existsSync(packPath)) { if (args.length) report("error", key, "pack 파일 없음"); continue; }
    checked++;
    const pageCount: number = JSON.parse(readFileSync(extractPath, "utf8")).pageCount;
    let pack: any;
    try { pack = JSON.parse(readFileSync(packPath, "utf8")); }
    catch (e) { report("error", key, `JSON 파싱 실패: ${e}`); continue; }
    validate(key, lec.id, pack, pageCount);
  }
}

console.log(`\n${checked}개 pack 검사: 오류 ${errors}, 경고 ${warnings}`);
process.exit(errors ? 1 : 0);

function report(level: "error" | "warn", key: string, msg: string) {
  level === "error" ? errors++ : warnings++;
  console.log(`${level === "error" ? "✗" : "△"} ${key}: ${msg}`);
}

function str(v: unknown) { return typeof v === "string" && v.trim().length > 0; }

// 수식 검사: $...$·$$...$$를 KaTeX로 실제 컴파일하고, 수식 밖에 남은 날것 표기와 짝 안 맞는 $를 잡음
function checkMath(key: string, where: string, text: string | undefined) {
  if (!text) return;
  walkMd(md.parse(text), (n) => {
    if (n.type === "text" && n.value.includes("**")) report("error", key, `${where} 굵게(**)가 닫히지 않음: ${n.value.slice(0, 40)}`);
    if (n.type === "delete") report("warn", key, `${where} 취소선(~~)이 있음`);
  });
  const codeSpans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/\\\$/g, "");
  for (const m of prose.matchAll(MATH)) {
    const tex = m[1] ?? m[2] ?? "";
    try { katex.renderToString(tex, { throwOnError: true, displayMode: m[1] !== undefined, strict: "ignore" }); }
    catch (e) { report("error", key, `${where} 수식 컴파일 실패: ${tex.slice(0, 70)} → ${String((e as Error).message).slice(0, 90)}`); }
  }
  const outside = prose.replace(MATH, "");
  if (outside.includes("$")) report("error", key, `${where} 짝이 안 맞는 $ (돈 표시는 \\$로)`);
  if (RAW_FORMULA.test(outside)) report("error", key, `${where} 수식 밖에 날것 표기: ${outside.match(/.{0,20}(?:[σΠπρ⋈θ]_|_\{).{0,20}/)?.[0]}`);
  else if (LOOSE_SYMBOL.test(outside)) report("warn", key, `${where} 수식 기호가 $...$ 밖에 있음: ${outside.match(/.{0,16}[σΠπρ⋈θ∧∨¬×∪∩≠].{0,16}/)?.[0]}`);
  for (const c of codeSpans) if (RAW_FORMULA.test(c) || /[σΠπρ⋈]/.test(c)) report("warn", key, `${where} 수식을 code로 씀: \`${c.slice(0, 40)}\` → $...$로`);
  for (const m of text.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    if (/[σΠπρ⋈∪∩]|_\{/.test(m[2]!)) report("warn", key, `${where} 수식을 코드 블록(\`\`\`${m[1]})에 씀 → $$ 블록으로`);
  }
  // 블록 수식은 $$만 있는 줄로 감싸야 함. 한 줄 $$식$$은 문장 안 식으로 그려짐
  const fenceless = text.replace(/```[\s\S]*?```/g, "");
  for (const line of fenceless.split("\n")) {
    if (line.includes("$$") && line.trim() !== "$$") report("error", key, `${where} $$는 따로 한 줄에: ${line.trim().slice(0, 50)}`);
  }
}

// content/<course>/course.json: 과목 전체 스토리. 없으면 넘어감
function validateCourseStory(course: { id: string; lectures: { id: string }[] }) {
  const path = join(APP, "content", course.id, "course.json");
  if (!existsSync(path)) return;
  const key = `${course.id}/course.json`;
  checked++;
  let story: any;
  try { story = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { report("error", key, `JSON 파싱 실패: ${e}`); return; }
  if (!str(story.question)) report("error", key, "question 없음");
  const known = new Set(course.lectures.map((l) => l.id));
  const ids = new Set<string>();
  for (const b of Array.isArray(story.story) ? story.story : []) {
    const where = `beat ${b.id ?? "?"}`;
    if (!str(b.id) || ids.has(b.id)) report("error", key, `${where} id 없음/중복`);
    ids.add(b.id);
    if (!Array.isArray(b.lectures) || !b.lectures.length) report("error", key, `${where} lectures 없음`);
    for (const l of b.lectures ?? []) if (!known.has(l)) report("error", key, `${where} 모르는 강의 ${l}`);
    for (const f of ["title", "problem", "answer"]) if (!str(b[f])) report("error", key, `${where} ${f} 없음`);
    for (const f of ["tradeoff", "extra", "bridge"]) if (f in b && !str(b[f])) report("error", key, `${where} ${f}가 빈 값 (없으면 키를 빼기)`);
    for (const f of ["title", "problem", "answer", "tradeoff", "extra", "bridge"]) checkMath(key, `${where} ${f}`, b[f]);
  }
  checkMath(key, "question", story.question);
  if (!ids.size) report("error", key, "story beat 없음");
}

// from..to 구간을 검사함. 전체 pack은 1..pageCount, 조각(part)은 맡은 구간만
function validate(key: string, id: string, pack: any, pageCount: number, from = 1, needQuestion = true) {
  const to = from + pageCount - 1;
  if (pack.lecture !== id) report("error", key, `lecture가 "${id}"가 아님: ${pack.lecture}`);
  if (needQuestion && !str(pack.question)) report("error", key, "question 없음");
  checkMath(key, "question", pack.question);

  // slides: from..to 를 순서대로 한 번씩
  const slides: any[] = Array.isArray(pack.slides) ? pack.slides : [];
  if (slides.length !== pageCount) report("error", key, `slides ${slides.length}개, 페이지는 ${pageCount}쪽(p${from}–${to})`);
  slides.forEach((s, i) => {
    const where = `p${s?.page ?? "?"}`;
    if (s.page !== from + i) report("error", key, `${i + 1}번째 slide의 page가 ${s.page} (기대 ${from + i})`);
    if (!TAGS.has(s.tag)) report("error", key, `${where} tag 오류: ${s.tag}`);
    if (!str(s.title)) report("error", key, `${where} title 없음`);
    if (!str(s.explain)) report("error", key, `${where} explain 없음`);
    else if (s.explain.length > LIMIT[s.tag]) report("warn", key, `${where} ${s.tag} explain ${s.explain.length}자 (권장 ${LIMIT[s.tag]}자 이하)`);
    checkMath(key, `${where} title`, s.title);
    checkMath(key, `${where} explain`, s.explain);
  });

  // story: from 순서, 겹치지 않음, 범위 안, 필수 필드
  const story: any[] = Array.isArray(pack.story) ? pack.story : [];
  if (story.length === 0) report("error", key, "story beat 없음");
  let prevTo = from - 1;
  const ids = new Set<string>();
  for (const b of story) {
    const where = `beat ${b.id ?? "?"}`;
    if (!str(b.id) || ids.has(b.id)) report("error", key, `${where} id 없음/중복`);
    ids.add(b.id);
    if (!Number.isInteger(b.from) || !Number.isInteger(b.to) || b.from < from || b.to > to || b.from > b.to)
      report("error", key, `${where} 범위 오류 ${b.from}-${b.to}`);
    if (b.from <= prevTo) report("error", key, `${where} 앞 beat와 겹치거나 순서가 뒤바뀜 (${b.from} <= ${prevTo})`);
    prevTo = b.to;
    for (const f of ["title", "problem", "answer"]) if (!str(b[f])) report("error", key, `${where} ${f} 없음`);
    for (const f of ["tradeoff", "extra", "bridge"]) if (f in b && !str(b[f])) report("error", key, `${where} ${f}가 빈 값 (없으면 키를 빼기)`);
    for (const f of ["title", "problem", "answer", "tradeoff", "extra", "bridge"]) {
      checkMath(key, `${where} ${f}`, b[f]);
      if (typeof b[f] === "string" && b[f].includes("$$")) report("error", key, `${where} ${f}: beat에는 $$ 블록 수식을 쓰지 않음`);
    }
  }

  // core 슬라이드가 어느 beat에도 안 걸리면 경고
  const covered = (p: number) => story.some((b) => b.from <= p && p <= b.to);
  const loose = slides.filter((s) => s.tag === "core" && !covered(s.page)).map((s) => s.page);
  if (loose.length) report("warn", key, `beat 밖 core 슬라이드: p${loose.join(", p")}`);
}
