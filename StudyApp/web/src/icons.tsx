// 도구줄용 작은 선 아이콘. currentColor를 따름
const base = {
  width: 18, height: 18, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor",
  strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
} as const;

export const IconSidebar = () => (
  <svg {...base}><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" /><path d="M7.5 3.5v13" /></svg>
);
export const IconSearch = () => (
  <svg {...base}><circle cx="8.5" cy="8.5" r="5" /><path d="m12.3 12.3 4.2 4.2" /></svg>
);
export const IconSliders = () => (
  <svg {...base}><path d="M3.5 6.5h8M15.5 6.5h1M3.5 13.5h1M8.5 13.5h8" /><circle cx="13.5" cy="6.5" r="2" /><circle cx="6.5" cy="13.5" r="2" /></svg>
);
export const IconKeyboard = () => (
  <svg {...base}><rect x="2.5" y="5" width="15" height="10" rx="2" /><path d="M6 8.5h.01M9 8.5h.01M12 8.5h.01M15 8.5h.01M6.5 12h7" /></svg>
);
export const IconChevron = () => (
  <svg {...base} width={14} height={14}><path d="m6 8 4 4 4-4" /></svg>
);
export const IconLeft = () => (
  <svg {...base} width={22} height={22}><path d="m12 5-5 5 5 5" /></svg>
);
export const IconRight = () => (
  <svg {...base} width={22} height={22}><path d="m8 5 5 5-5 5" /></svg>
);
export const IconSun = () => (
  <svg {...base}><circle cx="10" cy="10" r="3.4" /><path d="M10 2.6v1.7M10 15.7v1.7M2.6 10h1.7M15.7 10h1.7M4.8 4.8 6 6M14 14l1.2 1.2M4.8 15.2 6 14M14 6l1.2-1.2" /></svg>
);
export const IconMoon = () => (
  <svg {...base}><path d="M16.2 12.3A6.6 6.6 0 0 1 7.7 3.8a6.6 6.6 0 1 0 8.5 8.5Z" /></svg>
);
// 필기 도구
export const IconPen = () => (
  <svg {...base}><path d="M13.4 3.9a1.9 1.9 0 0 1 2.7 2.7l-8.9 8.9-3.6.9.9-3.6z" /><path d="m11.8 5.5 2.7 2.7" /></svg>
);
export const IconHighlighter = () => (
  <svg {...base}><path d="m11.6 3.6 4.8 4.8-6.6 6.6H5v-4.8z" /><path d="m5 15-1.6 1.6h4" /><path d="m8.6 6.6 4.8 4.8" /></svg>
);
export const IconEraser = () => (
  <svg {...base}><path d="m8.2 16.5-4.4-4.4a1.6 1.6 0 0 1 0-2.2l6.4-6.4a1.6 1.6 0 0 1 2.2 0l4.4 4.4a1.6 1.6 0 0 1 0 2.2l-6.4 6.4z" /><path d="m6.6 7.4 6 6M8.2 16.5h8.3" /></svg>
);
export const IconUndo = () => (
  <svg {...base}><path d="M7.5 5 4 8.5 7.5 12" /><path d="M4 8.5h8a4 4 0 0 1 0 8H9" /></svg>
);
export const IconRedo = () => (
  <svg {...base}><path d="M12.5 5 16 8.5 12.5 12" /><path d="M16 8.5H8a4 4 0 0 0 0 8h3" /></svg>
);
export const IconTrash = () => (
  <svg {...base}><path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.2 5.5l.8 10.6a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9l.8-10.6" /></svg>
);
