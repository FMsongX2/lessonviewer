/// <reference types="vite/client" />

interface Window {
  lessonViewer?: { setTheme: (theme: "system" | "light" | "dark") => void };
}
