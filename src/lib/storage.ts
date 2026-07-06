import type { Activity } from "./cpm";

/* 데이터 접근 계층 — 지금은 localStorage, 추후 서버(Supabase 등)로 교체 시
   이 파일의 loadProject/saveProject 구현만 바꾸면 됩니다. */

export interface ProjectData {
  startDate: string;
  activities: Activity[];
}

const KEY = "cpm-project-v1";

export function loadProject(): ProjectData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && Array.isArray(p.activities)) return p;
  } catch {
    /* 손상된 데이터는 무시하고 시드 사용 */
  }
  return null;
}

export function saveProject(p: ProjectData): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 저장 실패는 치명적이지 않음 */
  }
}
