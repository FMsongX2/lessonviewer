// 해설 속 코드 실행. 강의 하나당 Python 실행기(server/kernel.py) 하나를 띄워 노트북처럼 상태를 이어 감.
// 실습 정의는 content/<course>/labs/<lecture>.json, 작성법은 content/LABS.md.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lab, LabCell, Pack, RunResult } from "../shared/types";

const APP = join(import.meta.dir, "..");
const PYTHON = process.env.STUDYAPP_PYTHON ?? join(APP, "..", ".venv", "bin", "python");
export const DATASETS = join(APP, "data", "datasets");
const TIMEOUT = Number(process.env.STUDYAPP_CELL_TIMEOUT ?? 120_000);
const IDLE = 20 * 60_000;          // 20분 안 쓰면 실행기를 끔
const MAX_SESSIONS = 3;            // 동시에 띄워 둘 실행기 수. 넘으면 가장 오래 안 쓴 것부터 끔

export const labPath = (course: string, lecture: string) => join(APP, "content", course, "labs", `${lecture}.json`);

export function loadLab(course: string, lecture: string): Lab | null {
  const path = labPath(course, lecture);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as Lab; } catch { return null; }
}

export function loadPack(course: string, lecture: string): Pack | null {
  const path = join(APP, "content", course, `${lecture}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as Pack; } catch { return null; }
}

// 해설 Markdown의 코드 블록들. 화면(react-markdown)이 보여 주는 코드와 같은 글이 되게 끝 줄바꿈 하나를 뗌
export function codeBlocks(text: string): { lang: string; code: string }[] {
  return [...text.matchAll(/```([\w+#-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!.toLowerCase(), code: m[2]!.replace(/\n$/, "") }));
}

export function cellCode(pack: Pack | null, cell: LabCell): string | null {
  if (cell.code) return cell.code;
  const slide = pack?.slides.find((s) => s.page === cell.page);
  return slide ? codeBlocks(slide.explain)[cell.block ?? 0]?.code ?? null : null;
}

const isolated = (lab: Lab) => lab.isolate ?? lab.kernel === "sql";

// 공용 준비 코드(include)를 앞에 붙인 전체 setup
export function fullSetup(course: string, lab: Lab): string {
  const ext = lab.kernel === "sql" ? "sql" : "py";
  const parts = (lab.include ?? []).map((name) => {
    const path = join(APP, "content", course, "labs", "_shared", `${name}.${ext}`);
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(path)) throw new Error(`공용 준비 코드가 없어: _shared/${name}.${ext}`);
    return readFileSync(path, "utf8");
  });
  return [...parts, lab.setup].filter((x) => x.trim()).join("\n\n");
}

class Session {
  private proc: ReturnType<typeof Bun.spawn>;
  private pending = new Map<number, (r: RunResult) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private ready: Promise<void>;
  dead = false;
  setupDone = false;
  done = new Set<number>();         // 이 세션에서 이미 실행한 셀 번호
  lastUsed = Date.now();

  constructor(readonly key: string) {
    this.proc = Bun.spawn([PYTHON, "-u", join(import.meta.dir, "kernel.py")], {
      cwd: DATASETS, stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { ...process.env, STUDYAPP_DATA: DATASETS, MPLBACKEND: "Agg", PYTHONIOENCODING: "utf-8" },
    });
    let ok!: () => void;
    this.ready = new Promise((r) => (ok = r));
    this.read(ok);
    this.proc.exited.then(() => {
      this.dead = true;
      for (const [, resolve] of this.pending) resolve({ ok: false, stdout: "", outputs: [], error: "실행기가 종료됐어. 다시 실행하면 새로 띄울게.", ms: 0 });
      this.pending.clear();
    });
  }

  private async read(onReady: () => void) {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.ready) { onReady(); continue; }
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        } catch { /* 프로토콜 밖 줄은 무시 */ }
      }
    }
  }

  // 요청은 한 번에 하나씩. 시간 초과면 실행기를 끄고 알림
  run(kind: string, code: string, opt: { isolate?: boolean; prelude?: string; postlude?: string } = {}): Promise<RunResult> {
    const job = this.chain.then(async () => {
      await this.ready;
      this.lastUsed = Date.now();
      if (this.dead) return { ok: false, stdout: "", outputs: [], error: "실행기가 꺼져 있어. 다시 실행해 줘.", ms: 0 } as RunResult;
      const id = ++this.seq;
      return new Promise<RunResult>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.kill();
          resolve({ ok: false, stdout: "", outputs: [], error: `${TIMEOUT / 1000}초 안에 끝나지 않아서 멈췄어. 실행 환경도 처음 상태로 돌아갔어.`, ms: TIMEOUT });
        }, TIMEOUT);
        this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        const sink = this.proc.stdin as import("bun").FileSink;
        sink.write(JSON.stringify({ id, kind, code, ...opt }) + "\n");
        sink.flush();
      });
    });
    this.chain = job.catch(() => {});
    return job;
  }

  kill() {
    this.dead = true;
    try { this.proc.kill(); } catch { /* 이미 꺼짐 */ }
  }
}

const sessions = new Map<string, Session>();

function session(key: string): Session {
  let s = sessions.get(key);
  if (s && !s.dead) return s;
  s = new Session(key);
  sessions.set(key, s);
  const alive = [...sessions.values()].filter((x) => !x.dead).sort((a, b) => a.lastUsed - b.lastUsed);
  while (alive.length > MAX_SESSIONS) { const old = alive.shift()!; old.kill(); sessions.delete(old.key); }
  return s;
}

setInterval(() => {
  for (const [key, s] of sessions) if (s.dead || Date.now() - s.lastUsed > IDLE) { s.kill(); sessions.delete(key); }
}, 60_000).unref?.();

export function resetLab(course: string, lecture: string) {
  const key = `${course}/${lecture}`;
  sessions.get(key)?.kill();
  sessions.delete(key);
}

export function stopAll() {
  for (const s of sessions.values()) s.kill();
  sessions.clear();
}

const fail = (error: string): RunResult => ({ ok: false, stdout: "", outputs: [], error, ms: 0 });

// index번 셀을 실행. code가 있으면 오빠가 고친 코드로 실행함.
// 앞 셀의 상태가 이어지는 실습(Python)은 아직 안 돌린 앞 셀을 먼저 차례로 실행함(Jupyter의 '위 셀 모두 실행')
export async function runCell(course: string, lecture: string, index: number, edited?: string): Promise<RunResult> {
  const lab = loadLab(course, lecture);
  const pack = loadPack(course, lecture);
  const cell = lab?.cells[index];
  if (!lab || !cell) return fail("이 코드에는 실행 환경이 없어.");
  if (cell.skip) return fail(cell.skip);
  const s = session(`${course}/${lecture}`);
  const kind = lab.kernel;
  const iso = isolated(lab);
  const ran: number[] = [];

  if (!s.setupDone) {
    let setup: string;
    try { setup = fullSetup(course, lab); } catch (e) { return fail(String((e as Error).message)); }
    const r = await s.run(kind, setup);
    if (!r.ok) return { ...r, error: `실행 환경 준비 코드에서 막혔어.\n${r.error ?? ""}` };
    s.setupDone = true;
  }
  if (!iso) {
    for (let j = 0; j < index; j++) {
      const prev = lab.cells[j]!;
      if (s.done.has(j) || prev.skip) continue;
      const code = cellCode(pack, prev);
      if (!code) continue;
      const r = await s.run(kind, code, { prelude: prev.prelude });
      if (!r.ok) return { ...r, ran, error: `앞 셀(p.${prev.page})을 먼저 실행하다 막혔어.\n${r.error ?? ""}` };
      s.done.add(j);
      ran.push(prev.page);
    }
  }
  const code = edited ?? cellCode(pack, cell);
  if (!code) return fail("이 슬라이드에서 실행할 코드를 못 찾았어.");
  const r = await s.run(kind, code, { isolate: iso && kind === "sql", prelude: cell.prelude, postlude: cell.postlude });
  if (r.ok) s.done.add(index);
  return { ...r, ran };
}

// ── Jupyter 노트북 내보내기 ─────────────────────────────
const NB_DIR = join(APP, "notebooks");

type NbCell = { cell_type: "markdown" | "code"; metadata: Record<string, unknown>; source: string[]; outputs?: unknown[]; execution_count?: null };
const lines = (s: string) => s.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
const md = (s: string): NbCell => ({ cell_type: "markdown", metadata: {}, source: lines(s) });
const code = (s: string): NbCell => ({ cell_type: "code", metadata: {}, source: lines(s), outputs: [], execution_count: null });
const hash = (cells: NbCell[]) => Bun.hash(JSON.stringify(cells.map((c) => c.source.join("")))).toString(16);

const SQL_MAGIC = `# %%sql 셀을 DuckDB로 실행하는 준비. 'rollback'을 붙인 셀은 실행 뒤 바뀐 데이터를 되돌림
import duckdb
from IPython.core.magic import register_cell_magic

con = duckdb.connect()

@register_cell_magic
def sql(line, cell):
    rollback = "rollback" in line.split()
    if rollback:
        con.execute("BEGIN TRANSACTION")
    try:
        for stmt in duckdb.extract_statements(cell):
            cur = con.execute(stmt)
            if cur.description:
                display(cur.df())
    finally:
        if rollback:
            con.execute("ROLLBACK")`;

export function buildNotebook(course: string, lecture: string, title: string): string | null {
  const lab = loadLab(course, lecture);
  const pack = loadPack(course, lecture);
  if (!lab || !pack) return null;
  const sqlLab = lab.kernel === "sql";
  const iso = isolated(lab);
  const cells: NbCell[] = [
    md(`# ${title}\n\n${pack.question ? `> ${pack.question}\n\n` : ""}**데이터**: ${lab.data}\n\n위에서부터 차례로 실행하면 돼. 맨 위 준비 셀은 꼭 먼저 실행해 줘!`),
    code(`import os\nDATA = ${JSON.stringify(DATASETS)}\nos.chdir(DATA)${sqlLab ? `\n\n${SQL_MAGIC}` : ""}`),
  ];
  const setup = fullSetup(course, lab);
  if (setup.trim()) cells.push(code(sqlLab ? `%%sql\n${setup}` : setup));
  lab.cells.forEach((cell) => {
    const slide = pack.slides.find((s) => s.page === cell.page);
    const src = cellCode(pack, cell);
    if (!slide || !src) return;
    const head = (cell.block ?? 0) === 0 ? `## p.${cell.page} ${slide.title}\n\n${slide.explain}` : `### p.${cell.page}의 다음 코드`;
    cells.push(md(head + (cell.note ? `\n\n> 실행 메모: ${cell.note}` : "") + (cell.skip ? `\n\n> 실행 안 됨: ${cell.skip}` : "")
      + (cell.expectError ? "\n\n> 이 셀은 오류가 나는 게 정답이야! 오류 메시지를 읽어 봐." : "")));
    if (cell.skip) return;
    if (sqlLab) {
      // 되돌리는 셀은 준비 코드도 같은 셀 안에 둬야 함께 되돌아감
      // 한 셀에 이어 붙이므로 문장 끝 ;를 보장해야 다음 문장과 붙지 않음
      const end = (q: string) => (q.trimEnd().endsWith(";") ? q.trimEnd() : `${q.trimEnd()};`);
      const pre = cell.prelude ? `-- 이 셀을 위한 준비 코드\n${end(cell.prelude)}\n\n` : "";
      const post = cell.postlude ? `\n\n-- 실행 뒤 상태 확인\n${cell.postlude}` : "";
      cells.push(code(`%%sql${iso ? " rollback" : ""}\n${pre}${post ? end(src) : src}${post}`));
    } else {
      if (cell.prelude) cells.push(code(`# 이 셀을 위한 준비 코드\n${cell.prelude}`));
      cells.push(code(src));
      if (cell.postlude) cells.push(code(`# 실행 뒤 상태 확인\n${cell.postlude}`));
    }
  });
  const nb = {
    nbformat: 4, nbformat_minor: 4,
    metadata: {
      kernelspec: { name: "studyapp", display_name: "StudyApp (.venv)", language: "python" },
      language_info: { name: "python" },
      studyapp: { course, lecture, sourceHash: hash(cells) },
    },
    cells,
  };
  const dir = join(NB_DIR, course);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${lecture}.ipynb`);
  // 오빠가 노트북을 고쳤으면 덮어쓰지 않음: 저장해 둔 원본 hash와 지금 셀이 같을 때만 새로 씀
  if (existsSync(path)) {
    try {
      const old = JSON.parse(readFileSync(path, "utf8"));
      const untouched = old.metadata?.studyapp?.sourceHash === hash(old.cells ?? []);
      if (!untouched) return path;
    } catch { return path; }
  }
  writeFileSync(path, JSON.stringify(nb, null, 1) + "\n");
  return path;
}

export function openInEditor(path: string) {
  // VS Code(Jupyter 확장)로 열고, 없으면 기본 앱으로
  const p = Bun.spawn(["open", "-a", "Visual Studio Code", path], { stdout: "ignore", stderr: "ignore" });
  p.exited.then((code) => { if (code !== 0) Bun.spawn(["open", path]); });
}

export const labStat = (course: string, lecture: string) => {
  const path = labPath(course, lecture);
  return existsSync(path) ? statSync(path).mtimeMs : 0;
};
