import { useEffect, useState } from "react";

// 해시 라우팅: #/ (학습) #/library[/<document>?job=...] 또는 #/<course>/<lecture>?p=12
export type ReviewTab = "flagged" | "check";
export type Route =
  | { view: "dashboard"; course?: undefined }
  | { view: "library"; course?: undefined }
  | { view: "document"; documentId: string; jobId?: string; course?: undefined }
  | { view: "home"; course: string }
  | { view: "review"; course: string; tab: ReviewTab }
  | { view: "lecture"; course: string; lecture: string; page?: number };

export function parse(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [course, second] = path.split("/").filter(Boolean);
  if (!course) return { view: "dashboard" };
  if (course === "library") return second
    ? { view: "document", documentId: second, jobId: new URLSearchParams(query).get("job") || undefined }
    : { view: "library" };
  if (!second) return { view: "home", course };
  if (second === "review") return { view: "review", course, tab: new URLSearchParams(query).get("tab") === "check" ? "check" : "flagged" };
  const p = Number(new URLSearchParams(query).get("p"));
  return { view: "lecture", course, lecture: second, page: Number.isInteger(p) && p > 0 ? p : undefined };
}

export const href = {
  dashboard: () => "#/",
  library: () => "#/library",
  document: (id: string, jobId?: string) => `#/library/${encodeURIComponent(id)}${jobId ? `?job=${encodeURIComponent(jobId)}` : ""}`,
  home: (course: string) => `#/${course}`,
  review: (course: string, tab: ReviewTab = "flagged") => `#/${course}/review${tab === "check" ? "?tab=check" : ""}`,
  lecture: (course: string, lecture: string, page?: number) => `#/${course}/${lecture}${page ? `?p=${page}` : ""}`,
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
