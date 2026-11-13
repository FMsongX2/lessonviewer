// 수식·Markdown이 섞인 글을 한 줄 라벨용 평문으로 바꿈.
// 접힌 슬라이드 제목, 크게 보기 캡션, 검색 미리보기처럼 KaTeX로 그리지 않는 곳에 씀
const TEX: Record<string, string> = {
  sigma: "σ", Pi: "Π", pi: "π", bowtie: "⋈", times: "×", cup: "∪", cap: "∩", rho: "ρ", theta: "θ",
  leftarrow: "←", rightarrow: "→", land: "∧", lor: "∨", neg: "¬", lnot: "¬",
  neq: "≠", ne: "≠", le: "≤", leq: "≤", ge: "≥", geq: "≥", ldots: "…", dots: "…", cdots: "…", cdot: "·", in: "∈",
  equiv: "≡", approx: "≈", to: "→", quad: " ", qquad: " ", left: "", right: "",
};

const SUB = "₀₁₂₃₄₅₆₇₈₉";   // 숫자 아래첨자는 유니코드로: r_1 → r₁

function texToText(tex: string) {
  return tex
    .replace(/\\(?:text|mathrm|textit|mathit)\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:begin|end)\{[^{}]*\}/g, " ")              // \begin{gathered} 같은 환경 표시
    .replace(/\\\\/g, " ")                                   // 줄바꿈 \\
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => TEX[name] ?? name)   // 모르는 명령(\min 등)은 이름을 남김
    .replace(/_\{(\d+)\}|_(\d)/g, (_, a?: string, b?: string) => [...(a ?? b ?? "")].map((d) => SUB[Number(d)]).join(""))
    .replace(/_\{([^{}]*)\}/g, "[$1]")
    .replace(/\\([_{}%#&,; ])/g, (_, c: string) => (c === "," || c === ";" ? " " : c))
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const DOLLAR = "\u0000";

export function plainText(s = "") {
  return s
    .replace(/\\\$/g, DOLLAR)                                   // 돈 표시 \$는 수식이 아님
    .replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (_, a?: string, b?: string) => texToText(a ?? b ?? ""))
    .replaceAll(DOLLAR, "$")
    .replace(/[`*]/g, "")
    .trim();
}
