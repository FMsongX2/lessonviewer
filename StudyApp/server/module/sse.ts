// text/event-stream 해석기(WHATWG 규칙). 모델 제공자의 스트리밍 응답을 읽는 데 씀.

export interface SSEEvent { event: string; data: string }

const MAX_EVENT_CHARS = 8 * 1024 * 1024;   // 이벤트 하나가 이보다 크면 잘못된 응답으로 봄

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let dataChars = 0;
  // 한 줄을 처리하고, 빈 줄이면 모은 이벤트를 돌려줌
  function line(l: string): SSEEvent | null {
    if (l === "") {
      if (!data.length) { event = ""; return null; }
      const out = { event: event || "message", data: data.join("\n") };
      event = ""; data = []; dataChars = 0;
      return out;
    }
    if (l.startsWith(":")) return null;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      dataChars += value.length;
      if (dataChars > MAX_EVENT_CHARS) throw new Error("SSE event too large");
      data.push(value);
    }
    return null;
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // \r 로 끝났으면 다음 조각이 \n 일 수 있어 남겨 둠
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (ch !== "\n" && ch !== "\r") continue;
        if (ch === "\r" && i === buf.length - 1 && !done) break;
        const ev = line(buf.slice(start, i));
        if (ch === "\r" && buf[i + 1] === "\n") i++;
        start = i + 1;
        if (ev) yield ev;
      }
      buf = buf.slice(start);
      if (buf.length > MAX_EVENT_CHARS) throw new Error("SSE line too large");
      if (done) {
        if (buf) { const ev = line(buf); if (ev) yield ev; }
        const ev = line("");
        if (ev) yield ev;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// 응답 쪽: SSE 이벤트 한 개를 글로 만듦
export const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
