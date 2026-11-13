// generation.ts 동작 테스트. 모델은 주입한 가짜 callModel로 대신함(실제 provider 호출 없음).
// 실행: bun test server/generation.test.ts

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkStory, extractPdf, ExtractError, generatePack, GenerationError, parseModelJson,
  type CallModel, type ExtractManifest, type GenerateInput, type ModelRequest, type ModelResponse,
} from "./generation";

const root = mkdtempSync(join(tmpdir(), "lv-gen-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function fixture(pageCount: number, texts: string[] = []) {
  const dir = join(root, `case-${++seq}`);
  const extractDir = join(dir, "extract");
  mkdirSync(join(extractDir, "model"), { recursive: true });
  const pages = Array.from({ length: pageCount }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    writeFileSync(join(extractDir, `${n}.jpg`), "jpg");
    writeFileSync(join(extractDir, "model", `${n}.jpg`), "jpg");
    return {
      page: i + 1, text: texts[i] ?? `Slide ${i + 1} text`, textTruncated: false,
      image: `${n}.jpg`, modelImage: `model/${n}.jpg`, width: 1600, height: 900, modelWidth: 1024, modelHeight: 576, imageBytes: 3, modelImageBytes: 3,
    };
  });
  const manifest: ExtractManifest = { version: 1, pageCount, sha256: `sha-${seq}`, bytes: 1, title: "Test", width: 1600, height: 900, pages };
  writeFileSync(join(extractDir, "extract.json"), JSON.stringify(manifest));
  return { extractDir, workDir: join(dir, "work") };
}

function firstText(req: ModelRequest): string {
  const c = req.messages[0]!.content[0]!;
  return c.type === "text" ? c.text : "";
}

function requestedPages(req: ModelRequest): number[] {
  const m = firstText(req).match(/이번에 해설할 페이지: ([\d, ]+)/);
  return m ? m[1]!.split(",").map((s) => Number(s.trim())) : [];
}

function slide(page: number, extra: Record<string, unknown> = {}) {
  return { page, tag: page === 1 ? "meta" : "core", title: `개념 ${page}`, explain: `- **Concept ${page}**: 페이지 ${page}의 정의예요.\n- $x_${page} + 1$을 계산해요.`, digest: `p${page} 요약`, ...extra };
}

function storyFor(total: number) {
  return { question: "이 자료는 무엇을 설명하나요?", story: [{ from: 2, to: total, title: "핵심 흐름", problem: "기존 방식이 불편했어요.", answer: "새 개념이 그 문제를 풀어요." }] };
}

const ok = (text: string): ModelResponse => ({ text, stopReason: "end", usage: { inputTokens: 10, outputTokens: 5 } });

// 페이지 요청에는 요청한 페이지 slides를, 스토리 요청에는 story를 돌려주는 기본 모델
function honestModel(total: number, log: ModelRequest[] = []): CallModel {
  return async (req) => {
    log.push(req);
    if (firstText(req).includes("question과 story")) return ok(JSON.stringify(storyFor(total)));
    return ok(JSON.stringify({ slides: requestedPages(req).map((p) => slide(p)) }));
  };
}

const run = (f: { extractDir: string; workDir: string }, callModel: CallModel, signal = new AbortController().signal, extra: Partial<GenerateInput> = {}) =>
  generatePack({ lecture: "doc-1", title: "Test", extractDir: f.extractDir, workDir: f.workDir, callModel, signal, ...extra });

describe("generatePack", () => {
  test("모든 페이지를 순서대로 한 번씩 덮고 스토리를 붙임", async () => {
    const f = fixture(14);
    const log: ModelRequest[] = [];
    const progress: number[] = [];
    const res = await run(f, honestModel(14, log), undefined, { onProgress: (p) => progress.push(p.pagesDone) });
    expect(res.pack.slides.map((s) => s.page)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(res.pack.story[0]).toMatchObject({ id: "b1", from: 2, to: 14 });
    expect(res.pack.lecture).toBe("doc-1");
    expect(log.filter((r) => r.purpose === "pages").length).toBe(3); // 6+6+2
    expect(log.every((r) => r.maxTokens <= 16000)).toBe(true);
    expect(progress.at(-1)).toBe(14);
    expect(res.usage.calls).toBe(4);
  });

  test("깨진 JSON은 오류를 알려 고쳐 쓰게 함", async () => {
    const f = fixture(2);
    const log: ModelRequest[] = [];
    let first = true;
    const model: CallModel = async (req) => {
      log.push(req);
      if (firstText(req).includes("question과 story")) return ok(JSON.stringify(storyFor(2)));
      if (first) { first = false; return ok('{"slides": [ {"page": 1, '); }
      return ok("```json\n" + JSON.stringify({ slides: [slide(1), slide(2)] }) + "\n```");
    };
    const res = await run(f, model);
    expect(res.pack.slides.length).toBe(2);
    const repair = log.find((r) => r.purpose === "repair")!;
    expect(repair.messages.length).toBe(3);
    const last = repair.messages[2]!.content[0]!;
    expect(last.type === "text" && last.text.includes("JSON 파싱 실패")).toBe(true);
  });

  test("잘못된 tag·빠진 페이지·호칭은 고쳐 쓰게 하고, 끝내 못 맞추면 페이지를 지어내지 않고 실패함", async () => {
    const f = fixture(3);
    const model: CallModel = async (req) => {
      if (firstText(req).includes("question과 story")) return ok(JSON.stringify(storyFor(3)));
      // p3을 항상 빼먹고, p2는 tag가 틀림
      const slides = requestedPages(req).filter((p) => p !== 3).map((p) => (p === 2 ? slide(p, { tag: "important", explain: "오빠, 이건 중요해요." }) : slide(p)));
      return ok(JSON.stringify({ slides }));
    };
    const err = await run(f, model).catch((e) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.code).toBe("invalid_output");
    expect(err.message).toMatch(/p[23]/);
  });

  test("출력 한도에서 잘리면 묶음을 나눠 다시 요청함", async () => {
    const f = fixture(4);
    const sizes: number[] = [];
    const model: CallModel = async (req) => {
      if (firstText(req).includes("question과 story")) return ok(JSON.stringify(storyFor(4)));
      const pages = requestedPages(req);
      sizes.push(pages.length);
      if (pages.length > 2) return { text: '{"slides":[', stopReason: "max_tokens" };
      return ok(JSON.stringify({ slides: pages.map((p) => slide(p)) }));
    };
    const res = await run(f, model);
    expect(sizes).toEqual([4, 2, 2]);
    expect(res.pack.slides.map((s) => s.page)).toEqual([1, 2, 3, 4]);
  });

  test("provider 실패는 그대로 실패로 알리고 결과를 만들지 않음", async () => {
    const f = fixture(2);
    const model: CallModel = async () => { throw Object.assign(new Error("401 unauthorized"), { code: "auth", retryable: false }); };
    const err = await run(f, model).catch((e) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.code).toBe("provider");
    expect(err.message).toContain("auth");
  });

  test("취소하면 진행 중 호출 오류와 관계없이 cancelled", async () => {
    const f = fixture(8);
    const ac = new AbortController();
    const model: CallModel = async (req) => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const err = await run(f, model, ac.signal).catch((e) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.code).toBe("cancelled");
  });

  test("체크포인트가 있으면 재시도 때 모델을 다시 부르지 않음", async () => {
    const f = fixture(5);
    await run(f, honestModel(5));
    let calls = 0;
    const res = await run(f, async (req) => { calls++; return honestModel(5)(req); });
    expect(calls).toBe(0);
    expect(res.pack.slides.length).toBe(5);
  });

  test("uncertain은 review로 옮겨짐", async () => {
    const f = fixture(2);
    const model: CallModel = async (req) => {
      if (firstText(req).includes("question과 story")) return ok(JSON.stringify(storyFor(2)));
      return ok(JSON.stringify({ slides: requestedPages(req).map((p) => slide(p, p === 2 ? { uncertain: "그림 속 숫자가 흐려서 읽지 못했어요." } : {})) }));
    };
    const res = await run(f, model);
    expect(res.review).toEqual({ "2": "그림 속 숫자가 흐려서 읽지 못했어요." });
  });

  test("수식 컴파일 실패는 고쳐 쓰게 함", async () => {
    const f = fixture(2);
    let n = 0;
    const model: CallModel = async (req) => {
      if (firstText(req).includes("question과 story")) return ok(JSON.stringify(storyFor(2)));
      n++;
      const bad = n === 1 ? { explain: "- 식 $\\frac{1}{$ 를 봐요." } : {};
      return ok(JSON.stringify({ slides: requestedPages(req).map((p) => slide(p, p === 2 ? bad : {})) }));
    };
    const res = await run(f, model);
    expect(n).toBe(2);
    expect(res.pack.slides[1]!.explain).not.toContain("\\frac{1}{$");
  });
});

describe("parseModelJson / checkStory", () => {
  test("JSON에서 무효인 단일 백슬래시(LaTeX)를 고쳐 읽음", () => {
    expect(parseModelJson('{"a": "$\\sigma_p(r)$"}')).toEqual({ a: "$\\sigma_p(r)$" });
  });

  test("겹치거나 범위를 벗어난 beat는 오류", () => {
    const pages = [1, 2, 3, 4].map((page) => ({ page, tag: "core" as const }));
    const base = { title: "t", problem: "p", answer: "a" };
    expect(checkStory({ question: "q", story: [{ ...base, from: 1, to: 3 }, { ...base, from: 3, to: 4 }] }, pages).errors.length).toBeGreaterThan(0);
    expect(checkStory({ question: "q", story: [{ ...base, from: 1, to: 5 }] }, pages).errors.length).toBeGreaterThan(0);
    expect(checkStory({ question: "q", story: [{ ...base, from: 1, to: 4, bridge: "" }] }, pages).errors.length).toBeGreaterThan(0);
    const okStory = checkStory({ question: "q", story: [{ ...base, from: 1, to: 2 }, { ...base, from: 3, to: 4 }] }, pages);
    expect(okStory.errors).toEqual([]);
    expect(okStory.value!.story.map((b) => b.id)).toEqual(["b1", "b2"]);
  });
});

describe("extractPdf", () => {
  const python = existsSync(join(import.meta.dir, "..", "..", ".venv", "bin", "python"))
    ? join(import.meta.dir, "..", "..", ".venv", "bin", "python") : "python3";

  function makePdf(path: string, pages: number, encrypt = false) {
    const code = `import pymupdf,sys
d=pymupdf.open()
for i in range(${pages}):
    p=d.new_page(width=720,height=405); p.insert_text((72,72),f"Page {i+1} sigma")
${encrypt ? 'd.save(sys.argv[1],encryption=pymupdf.PDF_ENCRYPT_AES_256,user_pw="u",owner_pw="o")' : "d.save(sys.argv[1])"}`;
    const r = Bun.spawnSync([python, "-c", code, path]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  }

  test("PDF를 페이지 이미지·텍스트로 뽑음", async () => {
    const pdf = join(root, "ok.pdf");
    makePdf(pdf, 3);
    const out = join(root, "ok-out");
    const seen: number[] = [];
    const m = await extractPdf({ pdfPath: pdf, outDir: out, python, onProgress: (d) => seen.push(d) });
    expect(m.pageCount).toBe(3);
    expect(m.pages.map((p) => p.image)).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    expect(m.pages[1]!.text).toContain("Page 2");
    expect(m.pages.every((p) => Math.max(p.modelWidth, p.modelHeight) <= 1024)).toBe(true);
    expect(existsSync(join(out, "model", "003.jpg"))).toBe(true);
    expect(seen.at(-1)).toBe(3);
  });

  test("PDF가 아니거나 암호가 걸렸거나 페이지가 많으면 구분된 오류를 내고 출력 폴더를 남기지 않음", async () => {
    const fake = join(root, "fake.pdf");
    writeFileSync(fake, "hello, not a pdf");
    const enc = join(root, "enc.pdf");
    makePdf(enc, 1, true);
    const many = join(root, "many.pdf");
    makePdf(many, 4);
    const cases: [string, string, number | undefined][] = [[fake, "invalid_pdf", undefined], [enc, "encrypted", undefined], [many, "too_many_pages", 3]];
    for (const [pdf, code, maxPages] of cases) {
      const out = join(root, `bad-${code}`);
      const err = await extractPdf({ pdfPath: pdf, outDir: out, python, maxPages }).catch((e) => e);
      expect(err).toBeInstanceOf(ExtractError);
      expect(err.code).toBe(code);
      expect(existsSync(out)).toBe(false);
    }
  });

  test("비어 있지 않은 출력 폴더는 거부함", async () => {
    const pdf = join(root, "ok2.pdf");
    makePdf(pdf, 1);
    const out = join(root, "busy");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "x");
    const err = await extractPdf({ pdfPath: pdf, outDir: out, python }).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect(readdirSync(out)).toEqual(["keep.txt"]);
  });

  test("취소하면 python을 멈추고 cancelled", async () => {
    const pdf = join(root, "big.pdf");
    makePdf(pdf, 60);
    const ac = new AbortController();
    const out = join(root, "cancel-out");
    const p = extractPdf({ pdfPath: pdf, outDir: out, python, signal: ac.signal, onProgress: (d) => { if (d >= 1) ac.abort(); } });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect(err.code).toBe("cancelled");
    expect(existsSync(out)).toBe(false);
  });
});
