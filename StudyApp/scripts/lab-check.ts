// 실습(content/<course>/labs/<lecture>.json)을 처음부터 끝까지 실제로 실행해 봄.
// 실행: bun scripts/lab-check.ts <course | course/lecture ...> [--quiet]
//   - 셀마다 성공/실패와 결과 앞부분을 보여 주고, 전체 결과는 data/labs/<course>/<lecture>.json에 남김
//   - 해설 속 실행 언어(SQL/Python) 코드 블록 중 실습 셀이 없는 것도 알려 줌
// 실패한 셀이 하나라도 있으면 종료 코드 1
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cellCode, codeBlocks, loadLab, loadPack, resetLab, runCell, stopAll } from "../server/labs";
import type { RunOutput } from "../shared/types";

const APP = join(import.meta.dir, "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const quiet = process.argv.includes("--quiet");
const LANG: Record<string, string[]> = { sql: ["sql"], python: ["python", "py"] };

const targets: [string, string][] = [];
for (const a of args) {
  const [course, lecture] = a.split("/");
  if (lecture) { targets.push([course!, lecture]); continue; }
  const dir = join(APP, "content", course!, "labs");
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) targets.push([course!, f.replace(/\.json$/, "")]);
}
if (!targets.length) { console.error("사용법: bun scripts/lab-check.ts <course | course/lecture ...>"); process.exit(1); }

const brief = (o: RunOutput) => {
  if (o.type === "table") return `표 ${o.columns.join(", ")} (${o.total}행)` + o.rows.slice(0, 3).map((r) => `\n        | ${r.map(String).join(" | ")}`).join("");
  if (o.type === "image") return "그림 1장";
  return o.text.split("\n").slice(0, 4).join("\n        ").slice(0, 300);
};

let failed = 0;
for (const [course, lecture] of targets) {
  const lab = loadLab(course, lecture);
  const pack = loadPack(course, lecture);
  console.log(`\n== ${course}/${lecture}`);
  if (!lab) { console.log("  실습 파일이 없거나 JSON이 깨졌어"); failed++; continue; }
  if (!pack) { console.log("  해설 pack이 없어"); failed++; continue; }
  const problems: string[] = [];
  if (lab.lecture !== lecture) problems.push(`lecture 값이 파일 이름과 달라: ${lab.lecture}`);
  if (lab.kernel !== "sql" && lab.kernel !== "python") problems.push(`kernel은 sql 또는 python: ${lab.kernel}`);
  if (!lab.data?.trim()) problems.push("data(어떤 데이터인지) 설명이 비었어");
  const covered = new Set<string>();
  lab.cells.forEach((cell, i) => {
    const slide = pack.slides.find((s) => s.page === cell.page);
    if (!slide) { problems.push(`셀 ${i}: p.${cell.page} 슬라이드가 없어`); return; }
    const block = codeBlocks(slide.explain)[cell.block ?? 0];
    if (!block) { problems.push(`셀 ${i}: p.${cell.page}에 ${cell.block ?? 0}번 코드 블록이 없어`); return; }
    if (!LANG[lab.kernel]?.includes(block.lang)) problems.push(`셀 ${i}: p.${cell.page} 블록 언어(${block.lang})가 kernel(${lab.kernel})과 달라`);
    covered.add(`${cell.page}#${cell.block ?? 0}`);
  });
  for (const s of pack.slides) codeBlocks(s.explain).forEach((b, k) => {
    if (LANG[lab.kernel]?.includes(b.lang) && !covered.has(`${s.page}#${k}`)) problems.push(`셀 없음: p.${s.page} ${k}번 ${b.lang} 블록`);
  });
  for (const p of problems) console.log(`  ! ${p}`);

  resetLab(course, lecture);
  const results: unknown[] = [];
  for (let i = 0; i < lab.cells.length; i++) {
    const cell = lab.cells[i]!;
    if (cell.skip) { console.log(`  - p.${cell.page}#${cell.block ?? 0} 건너뜀: ${cell.skip}`); results.push({ page: cell.page, block: cell.block ?? 0, skip: cell.skip }); continue; }
    const r = await runCell(course, lecture, i);
    results.push({ page: cell.page, block: cell.block ?? 0, code: cellCode(pack, cell), ...r, outputs: r.outputs.map((o) => (o.type === "image" ? { type: "image" } : o)) });
    if (cell.expectError) {
      if (r.ok) { failed++; console.log(`  ✗ p.${cell.page}#${cell.block ?? 0} 오류가 나야 하는 셀인데 성공했어`); }
      else if (!quiet) console.log(`  ✓ p.${cell.page}#${cell.block ?? 0} 의도한 오류: ${(r.error ?? "").trim().split("\n")[0]!.slice(0, 160)}`);
      continue;
    }
    if (!r.ok) {
      failed++;
      console.log(`  ✗ p.${cell.page}#${cell.block ?? 0} (${r.ms}ms)\n      ${(r.error ?? "").trim().split("\n").slice(-6).join("\n      ")}`);
    } else if (!quiet) {
      console.log(`  ✓ p.${cell.page}#${cell.block ?? 0} (${r.ms}ms)${r.stdout ? `\n      출력: ${r.stdout.trim().split("\n").slice(0, 3).join(" / ").slice(0, 200)}` : ""}${r.outputs.map((o) => `\n      ${brief(o)}`).join("")}`);
    }
  }
  const outDir = join(APP, "data", "labs", course);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${lecture}.json`), JSON.stringify({ problems, results }, null, 1));
  const n = lab.cells.length, s = lab.cells.filter((c) => c.skip).length;
  console.log(`  셀 ${n}개 (건너뜀 ${s}), 구조 문제 ${problems.length}개`);
  failed += problems.filter((p) => !p.startsWith("셀 없음")).length;
  resetLab(course, lecture);
}
stopAll();
console.log(failed ? `\n실패 ${failed}건` : "\n전부 통과");
process.exit(failed ? 1 : 0);
