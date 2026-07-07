import { Activity, CpmResult, fmtISO, fmtShort, todayUTC } from "./cpm";

export interface Risk {
  category: string;
  severity: string;
  title: string;
  description: string;
  mitigation: string;
  relatedIds?: string[];
}

export interface AiResult {
  summary?: string;
  risks?: Risk[];
}

export function formatActivitiesForAI(acts: Activity[], cpm: CpmResult): string {
  return acts
    .map((a) => {
      const c = cpm.byId.get(a.id);
      const preds =
        (a.predecessors || [])
          .map((p) => `${p.activityId}(${p.relation}${p.lagMonths ? `,lag ${p.lagMonths}개월` : ""})`)
          .join(" / ") || "-";
      return `${a.id} | ${a.name} | 공종:${a.wbs || "-"} | 담당부서:${a.owner || "-"} | 기간 ${a.durationMonths}개월 | 선행: ${preds} | ES ${fmtShort(c?.es)} ~ EF ${fmtShort(c?.ef)} | 총여유 ${c?.tf ?? "-"}일 | ${c?.critical ? "★주공정" : ""} ${c?.error ? `오류:${c.error}` : ""}`;
    })
    .join("\n");
}

export function extractCriticalPath(acts: Activity[], cpm: CpmResult): string {
  return acts
    .filter((a) => cpm.byId.get(a.id)?.critical)
    .map((a) => a.id)
    .join(" → ");
}

export async function requestAiAnalysis(
  startDate: string,
  finishDate: string,
  totalMonths: string,
  acts: Activity[],
  cpm: CpmResult,
  critCount: number
): Promise<AiResult> {
  const rows = formatActivitiesForAI(acts, cpm);
  const criticalPath = extractCriticalPath(acts, cpm);

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDate,
      finishDate,
      totalMonths,
      activityCount: acts.length,
      criticalCount: critCount,
      criticalPath,
      today: fmtISO(todayUTC()),
      rows,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "분석 실패");
  if (!data.risks && !data.summary) throw new Error("응답이 비어 있습니다");
  return data;
}
