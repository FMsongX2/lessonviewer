// 큰 강의를 여러 유미가 나눠 쓴 조각(content/<course>/<lecture>.partN.json)을 하나의 pack으로 합침.
// 실행: bun scripts/merge-parts.ts <course>/<lecture> [--keep]
// 조각은 page 구간이 겹치지 않고 이어져야 함. 합친 뒤 조각 파일은 지움(--keep이면 남김).
// question은 part1의 것을 쓰고, beat id는 b1부터 다시 매김.

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const [target, ...flags] = process.argv.slice(2);
if (!target?.includes("/")) {
  console.error("사용법: bun scripts/merge-parts.ts <course>/<lecture> [--keep]");
  process.exit(1);
}
const [course, lecture] = target.split("/") as [string, string];
const dir = join(APP, "content", course);
const parts = readdirSync(dir)
  .map((f) => f.match(new RegExp(`^${lecture.replace(/[-]/g, "\\-")}\\.part(\\d+)\\.json$`)))
  .filter((m): m is RegExpMatchArray => !!m)
  .sort((a, b) => Number(a[1]) - Number(b[1]))
  .map((m) => ({ file: join(dir, m[0]), pack: JSON.parse(readFileSync(join(dir, m[0]), "utf8")) }));
if (parts.length < 2) {
  console.error(`조각이 2개 이상 있어야 함: ${parts.map((p) => p.file).join(", ") || "없음"}`);
  process.exit(1);
}

const extract = JSON.parse(readFileSync(join(APP, "data", "extract", course, `${lecture}.json`), "utf8"));
const slides = parts.flatMap((p) => p.pack.slides).sort((a: any, b: any) => a.page - b.page);
const missing = Array.from({ length: extract.pageCount }, (_, i) => i + 1).filter((n) => !slides.some((s: any) => s.page === n));
const dupes = slides.filter((s: any, i: number) => slides[i - 1]?.page === s.page).map((s: any) => s.page);
if (missing.length || dupes.length) {
  console.error(`페이지가 맞지 않음. 빠짐: ${missing.join(", ") || "없음"} / 겹침: ${dupes.join(", ") || "없음"}`);
  process.exit(1);
}

const story = parts.flatMap((p) => p.pack.story).sort((a: any, b: any) => a.from - b.from)
  .map((b: any, i: number) => ({ ...b, id: `b${i + 1}` }));
const question = parts[0]!.pack.question;
if (!question) { console.error("part1에 question이 없음"); process.exit(1); }

const out = join(dir, `${lecture}.json`);
if (existsSync(out) && !flags.includes("--force")) {
  console.error(`${out} 이 이미 있음. 덮어쓰려면 --force`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify({ lecture, question, story, slides }, null, 2) + "\n");
if (!flags.includes("--keep")) parts.forEach((p) => unlinkSync(p.file));
console.log(`${course}/${lecture}: 조각 ${parts.length}개 → slides ${slides.length}, beats ${story.length}`);
