import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";

// 수식은 $...$(문장 안), $$...$$(따로 한 줄)에 LaTeX로 씀. 돈 표시 $는 \$로 씀. 규칙은 content/GUIDE.md
// singleTilde: false — "0~9"처럼 범위에 쓴 ~ 두 개가 취소선이 되지 않게 함
// remark-cjk-friendly — "**term (abc)**이다"처럼 닫는 ** 뒤에 한글 조사가 붙어도 굵게가 닫히게 함
const remark: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }], remarkMath, remarkCjkFriendly];
const rehype: Options["rehypePlugins"] = [[rehypeKatex, { strict: "ignore", output: "htmlAndMathml" }]];

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

// 코드 블록을 언어별로 가볍게 칠함: 키워드, 문자열, 숫자, 주석. 모르는 언어는 그대로 둠
const LANGS: Record<string, { keywords: Set<string>; comment: string; string: string; caseless?: boolean }> = {
  sql: {
    caseless: true, comment: String.raw`--[^\n]*`, string: String.raw`'(?:[^']|'')*'|"[^"]*"`,
    keywords: words(`select from where and or not in is null as distinct all union intersect except insert into values
      update set delete create table drop alter add primary key foreign references check unique default join inner left right full
      outer natural on using group by having order asc desc limit like between exists some any with view index database use
      count sum avg min max char varchar int integer numeric date time truncate cascade constraint grant revoke case when then else end`),
  },
  js: {
    comment: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`, string: String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + "`(?:[^`\\\\]|\\\\.)*`",
    keywords: words(`const let var function return if else for while do switch case break continue new class extends super this
      import export from default async await try catch finally throw typeof instanceof in of null undefined true false yield
      static get set delete void require module`),
  },
  python: {
    comment: String.raw`#[^\n]*`, string: String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`,
    keywords: words(`def return if elif else for while in not and or is None True False class import from as with try except
      finally raise lambda yield pass break continue global nonlocal assert del async await self`),
  },
  c: {
    comment: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/|#\s*(?:include|define|ifndef|ifdef|endif|pragma)[^\n]*`, string: String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`,
    keywords: words(`int char void float double long short unsigned signed const static struct union enum typedef return if else
      for while do switch case break continue sizeof uint8_t uint16_t uint32_t uint64_t size_t bool true false NULL nullptr
      class public private protected namespace using template typename auto new delete std string vector`),
  },
};
const ALIAS: Record<string, string> = {
  javascript: "js", ts: "js", typescript: "js", jsx: "js", tsx: "js", node: "js", json: "js",
  py: "python", cpp: "c", "c++": "c", h: "c", hpp: "c",
};

function highlight(code: string, lang: string): ReactNode[] | null {
  const spec = LANGS[ALIAS[lang] ?? lang];
  if (!spec) return null;
  const re = new RegExp(`(${spec.comment})|(${spec.string})|(\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_][A-Za-z0-9_]*)`, "g");
  const out: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [tok, comment, str, num, word] = m;
    const isKw = word && spec.keywords.has(spec.caseless ? word.toLowerCase() : word);
    const cls = comment ? "c" : str ? "s" : num ? "n" : isKw ? "k" : null;
    out.push(cls ? <span key={i++} className={`sql-${cls}`}>{tok}</span> : tok);
    last = m.index + tok.length;
  }
  out.push(code.slice(last));
  return out;
}

const components: Components = {
  // "보충:"으로 시작하는 문단은 슬라이드 밖 내용이라 따로 표시함
  p({ node, children }) {
    const first = node?.children[0];
    const extra = first?.type === "text" && first.value.startsWith("보충:");
    return <p className={extra ? "extra" : undefined}>{children}</p>;
  },
  code({ className, children }) {
    const lang = className?.match(/language-([\w+#-]+)/)?.[1]?.toLowerCase();
    const painted = lang ? highlight(String(children).replace(/\n$/, ""), lang) : null;
    return <code className={className}>{painted ?? children}</code>;
  },
  table({ children }) {
    return <div className="table-wrap"><table>{children}</table></div>;
  },
};

// 코드 블록 자리에 다른 것(실행 셀)을 그릴 때 씀. block은 해설 안에서 몇 번째 코드 블록인지(0부터)
export type RenderBlock = (block: number, lang: string, code: string, pre: ReactNode) => ReactNode;

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] };
const textOf = (n: HastNode): string => n.type === "text" ? n.value ?? "" : (n.children ?? []).map(textOf).join("");

export const Markdown = memo(function Markdown({ text, renderBlock, untrusted = false }: { text: string; renderBlock?: RenderBlock; untrusted?: boolean }) {
  if (!renderBlock) return <ReactMarkdown disallowedElements={untrusted ? ["img"] : undefined} remarkPlugins={remark} rehypePlugins={rehype} components={components}>{text}</ReactMarkdown>;
  // react-markdown은 위에서부터 차례로 그리므로, 그리는 순서로 코드 블록 번호를 셈
  let block = 0;
  const withCells: Components = {
    ...components,
    pre({ node, children }) {
      const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
      const cls = code?.properties?.className;
      const lang = (Array.isArray(cls) ? cls.join(" ") : String(cls ?? "")).match(/language-([\w+#-]+)/)?.[1]?.toLowerCase() ?? "";
      const pre = <pre>{children}</pre>;
      return <>{renderBlock(block++, lang, code ? textOf(code).replace(/\n$/, "") : "", pre)}</>;
    },
  };
  return <ReactMarkdown disallowedElements={untrusted ? ["img"] : undefined} remarkPlugins={remark} rehypePlugins={rehype} components={withCells}>{text}</ReactMarkdown>;
});

// beat 필드·질문처럼 한 문단짜리 글: `code`, **굵게**, $수식$만 살리고 문단 태그는 벗김
const inlineComponents: Components = { ...components, p: ({ children }) => <>{children}</> };

export const Inline = memo(function Inline({ text }: { text: string }) {
  return <ReactMarkdown disallowedElements={["img"]} remarkPlugins={remark} rehypePlugins={rehype} components={inlineComponents}>{text}</ReactMarkdown>;
});
