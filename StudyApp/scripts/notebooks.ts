// 실습이 있는 모든 강의를 Jupyter 노트북(notebooks/<course>/<lecture>.ipynb)으로 만듦.
// 오빠가 고친 노트북은 덮어쓰지 않음(server/labs.ts buildNotebook).
// 실행: bun scripts/notebooks.ts [course ...]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNotebook } from "../server/labs";

const APP = join(import.meta.dir, "..");
const config = JSON.parse(readFileSync(join(APP, "courses.json"), "utf8")).courses as { id: string; lectures: { id: string; week: string; title: string }[] }[];
const only = process.argv.slice(2);
for (const c of config) {
  if (only.length && !only.includes(c.id)) continue;
  const dir = join(APP, "content", c.id, "labs");
  if (!existsSync(dir)) continue;
  const labs = new Set(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
  for (const l of c.lectures) if (labs.has(l.id)) console.log(buildNotebook(c.id, l.id, `${l.week} ${l.title}`));
}
