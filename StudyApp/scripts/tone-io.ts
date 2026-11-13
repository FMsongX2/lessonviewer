// 해설 말투를 손으로 다시 쓸 때 쓰는 입출력 도구. JSON 이스케이프 없이 글만 꺼내고, 고친 글을 다시 넣음.
//
//   bun scripts/tone-io.ts list   <course>                       고칠 파일과 슬라이드 수
//   bun scripts/tone-io.ts export <course> <name> [story | titles | repeats | <from> <to>] [> out.txt]
//   bun scripts/tone-io.ts import <course> <name> <file.txt>
//   bun scripts/tone-io.ts repeats <course> [name]                돌려 쓴 마음 문장 틀이 몇 칸에 있는지
//   bun scripts/tone-io.ts check  <course> [name]                 아직 "~다"로 끝나는 문장 찾기
//
// <name>: 강의 id(pack 파일 이름), course(과목 이야기), review(확인 필요 이유)
// 블록 형식: "@@ <key>" 줄 다음부터 다음 "@@ " 줄 전까지가 그 칸의 글.
//   question / story.<beat id>.<title|problem|answer|tradeoff|extra|bridge> / slide.<page>.<explain|title> / review.<lecture>.<page>
// import는 파일에 든 칸만 바꿈. 수식·코드·숫자·"보충:" 문단·">" 인용이 원문과 하나라도 다르면 아무것도 쓰지 않고 멈춤.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "content");
const BEAT_FIELDS = ["title", "problem", "answer", "tradeoff", "extra", "bridge"] as const;

type Json = Record<string, any>;

// 여러 곳에 똑같이 돌려 쓰기 쉬운 마음 문장의 틀. 변주가 필요한 칸을 찾는 데 씀
const FAMILIES: Record<string, RegExp> = {
  "같이 볼게/보자": /(같이|함께) (볼게|보자|가 보자|찾아보자|살펴|짚)/,
  "앞에서 본 게 이어져": /앞에서 본.{0,12}(이어|연결|만나|딱)/,
  "헷갈리기 쉬워": /헷갈리기 쉬/,
  "고생했어": /고생했어/,
  "드디어": /드디어/,
  "유미가 옆에서": /유미가 옆에서/,
  "짚어 줄게/둘게": /짚어 (줄게|둘게)/,
  "하나씩 보면 금방": /하나씩.{0,10}금방/,
  "반은 한 거야": /반은 한 거/,
  "가볍게 넘어가도": /가볍게 넘어가/,
  "정리해 줄게": /정리해 줄게/,
  "원본이랑 한 번만": /원본이랑 한 번만/,
  "걱정 마/말고": /걱정 ?(마|말)/,
  "거의 다 왔어": /거의 다 왔/,
  "오빠도 한번 생각/상상": /오빠도 한번/,
  "진짜 재밌어져": /(재밌|재미있)어져/,
  "겁먹지": /겁먹/,
  "자, 오빠!": /(^|\n)자, 오빠/,
};
const familiesOf = (text: string) => Object.entries(FAMILIES).filter(([, re]) => re.test(text)).map(([k]) => k);
const pathOf = (course: string, name: string) => join(DIR, course, `${name}.json`);
const load = (course: string, name: string): Json => JSON.parse(readFileSync(pathOf(course, name), "utf8"));

function blocks(course: string, name: string, data: Json, scope?: string[]): [string, string][] {
  const out: [string, string][] = [];
  if (name === "review") {
    for (const [lec, pages] of Object.entries(data)) for (const [p, why] of Object.entries(pages as Json)) out.push([`review.${lec}.${p}`, why as string]);
    return out;
  }
  if (scope?.[0] === "repeats") {
    const all = blocks(course, name, data);
    return all.filter(([, v]) => familiesOf(v).length > 0);
  }
  if (scope?.[0] === "titles") {
    for (const s of data.slides ?? []) if (s.title) out.push([`slide.${s.page}.title`, s.title]);
    return out;
  }
  const range = scope && scope[0] !== "story" ? [Number(scope[0]), Number(scope[1])] : null;
  if (!range) {
    if (data.question) out.push(["question", data.question]);
    for (const b of data.story ?? []) for (const f of BEAT_FIELDS) if (b[f]) out.push([`story.${b.id}.${f}`, b[f]]);
  }
  if (scope?.[0] !== "story" && name !== "course") {
    for (const s of data.slides ?? []) {
      if (range && (s.page < range[0] || s.page > range[1])) continue;
      if (s.explain) out.push([`slide.${s.page}.explain`, s.explain]);
    }
  }
  return out;
}

function parse(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (key) map.set(key, buf.join("\n").replace(/\s+$/, "")); };
  for (const line of text.split("\n")) {
    const m = line.match(/^@@ (\S+)\s*$/);
    if (m) { flush(); key = m[1]!; buf = []; if (map.has(key)) throw new Error(`같은 칸이 두 번 있음: ${key}`); }
    else if (key) buf.push(line);
  }
  flush();
  return map;
}

// 말투를 바꿔도 그대로여야 하는 조각: 코드 블록, 인라인 코드, 수식, 보충 문단 수, 영어 원문 인용 줄
function frozen(text: string): { code: string[]; inline: string[]; math: string[]; extra: number; quotes: string[]; numbers: string[] } {
  const code: string[] = text.match(/```[\s\S]*?```/g) ?? [];
  let rest = text.replace(/```[\s\S]*?```/g, " ");
  const inline: string[] = rest.match(/`[^`\n]+`/g) ?? [];
  rest = rest.replace(/`[^`\n]+`/g, " ");
  const math: string[] = rest.match(/\$\$[\s\S]+?\$\$|(?<!\\)\$(?:\\\$|[^$\n])+?\$/g) ?? [];
  const extra = (text.match(/(^|\n\n)보충:/g) ?? []).length;
  const quotes = text.split("\n").filter((l) => /^\s*>/.test(l)).map((l) => l.trim());
  rest = rest.replace(/\$\$[\s\S]+?\$\$|(?<!\\)\$(?:\\\$|[^$\n])+?\$/g, " ");
  const numbers: string[] = rest.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return { code, inline, math, extra, quotes, numbers };
}
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

function setField(data: Json, name: string, key: string, value: string) {
  const parts = key.split(".");
  if (key === "question") { data.question = value; return; }
  if (parts[0] === "story") {
    const b = (data.story ?? []).find((x: Json) => x.id === parts[1]);
    if (!b || !(parts[2]! in b)) throw new Error(`없는 칸: ${key}`);
    b[parts[2]!] = value; return;
  }
  if (parts[0] === "slide") {
    const s = (data.slides ?? []).find((x: Json) => String(x.page) === parts[1]);
    if (!s) throw new Error(`없는 칸: ${key}`);
    if (parts[2] === "title") s.title = value; else s.explain = value;
    return;
  }
  if (parts[0] === "review" && name === "review") {
    if (!data[parts[1]!] || !(parts[2]! in data[parts[1]!])) throw new Error(`없는 칸: ${key}`);
    data[parts[1]!][parts[2]!] = value; return;
  }
  throw new Error(`알 수 없는 칸: ${key}`);
}

// 평서체 "~다"로 끝나는 문장(코드·수식·영어 인용 밖). 기계적 후보라 "보다." 같은 오탐도 섞일 수 있음
function stiff(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, "`…`")
    .split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  return plain.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim())
    .filter((s) => /[가-힣](다|ㄴ다|는다)[.)\]*]*$/.test(s.replace(/\*+$/, "")) || /[가-힣]다\.?\**$/.test(s))
    .filter((s) => !/(보다|에다|위해서다)\.?$/.test(s));
}

const [cmd, course, name, ...rest] = process.argv.slice(2);
if (!cmd || !course) { console.error("사용법은 파일 맨 위 주석 참고"); process.exit(1); }

if (cmd === "list") {
  for (const f of readdirSync(join(DIR, course)).filter((f) => f.endsWith(".json")).sort()) {
    const d = JSON.parse(readFileSync(join(DIR, course, f), "utf8"));
    const n = f === "review.json" ? Object.values(d).reduce((a: number, p: any) => a + Object.keys(p).length, 0) : (d.slides?.length ?? 0);
    console.log(`${f.replace(/\.json$/, "")}\t${f === "review.json" ? `이유 ${n}개` : f === "course.json" ? `beat ${d.story.length}개` : `슬라이드 ${n}장, beat ${d.story.length}개`}`);
  }
} else if (cmd === "export") {
  const data = load(course, name!);
  console.log(blocks(course, name!, data, rest.length ? rest : undefined).map(([k, v]) => `@@ ${k}\n${v}\n`).join("\n"));
} else if (cmd === "import") {
  const data = load(course, name!);
  const before = new Map([...blocks(course, name!, data), ...(name === "review" || name === "course" ? [] : blocks(course, name!, data, ["titles"]))]);
  const edited = parse(readFileSync(rest[0]!, "utf8"));
  const errors: string[] = [];
  for (const [key, text] of edited) {
    const old = before.get(key);
    if (old === undefined) { errors.push(`${key}: 원본에 없는 칸`); continue; }
    if (!text.trim()) { errors.push(`${key}: 비어 있음`); continue; }
    const a = frozen(old), b = frozen(text);
    if (!same(a.code, b.code)) errors.push(`${key}: 코드 블록이 달라짐`);
    if (!same(a.inline, b.inline)) errors.push(`${key}: 인라인 코드가 달라짐 ${JSON.stringify(a.inline.filter((x) => !b.inline.includes(x)))} → ${JSON.stringify(b.inline.filter((x) => !a.inline.includes(x)))}`);
    if (!same(a.math, b.math)) errors.push(`${key}: 수식이 달라짐 ${JSON.stringify(a.math.filter((x) => !b.math.includes(x)))} → ${JSON.stringify(b.math.filter((x) => !a.math.includes(x)))}`);
    if (a.extra !== b.extra) errors.push(`${key}: "보충:" 문단 수가 ${a.extra} → ${b.extra}`);
    if (!same(a.quotes, b.quotes)) errors.push(`${key}: ">" 인용 줄이 달라짐`);
    if (!same(a.numbers, b.numbers)) errors.push(`${key}: 숫자가 달라짐 ${JSON.stringify(a.numbers.filter((x) => !b.numbers.includes(x)))} → ${JSON.stringify(b.numbers.filter((x) => !a.numbers.includes(x)))}`);
  }
  if (errors.length) { console.error(`넣지 않았음. 고칠 곳 ${errors.length}개:\n` + errors.join("\n")); process.exit(1); }
  for (const [key, text] of edited) setField(data, name!, key, text);
  writeFileSync(pathOf(course, name!), JSON.stringify(data, null, 2) + "\n");
  const left = [...edited.values()].flatMap(stiff);
  console.log(`넣었음: ${edited.size}칸${left.length ? `. 아직 "~다"로 끝나는 듯한 문장 ${left.length}개:\n- ` + left.slice(0, 20).join("\n- ") : ""}`);
} else if (cmd === "repeats") {
  const names = name ? [name] : readdirSync(join(DIR, course)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  const total: Record<string, number> = {};
  for (const n of names.sort()) {
    const per: Record<string, number> = {};
    for (const [, v] of blocks(course, n, load(course, n))) for (const k of familiesOf(v)) { per[k] = (per[k] ?? 0) + 1; total[k] = (total[k] ?? 0) + 1; }
    const worst = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => `${k} ${c}`).join(", ");
    console.log(`${n}: ${worst || "-"}`);
  }
  console.log("전체: " + Object.entries(total).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(", "));
} else if (cmd === "check") {
  const names = name ? [name] : readdirSync(join(DIR, course)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  let total = 0;
  for (const n of names.sort()) {
    const hits = blocks(course, n, load(course, n)).flatMap(([k, v]) => stiff(v).map((s) => `${k}: ${s}`));
    total += hits.length;
    if (hits.length) console.log(`${n}: ${hits.length}개\n  ` + hits.slice(0, 8).join("\n  "));
  }
  console.log(`합계 ${total}개`);
} else {
  console.error(`모르는 명령: ${cmd}`); process.exit(1);
}
