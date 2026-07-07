import * as XLSX from "xlsx";
import { Activity, CpmResult, fmtISO, fmtDur, addDays, addCalMonths, pad2 } from "./cpm";

interface Timeline {
  t0: number;
  t1: number;
  months: number[];
}

export function buildExcelWorkbook(
  acts: Activity[],
  cpm: CpmResult,
  timeline: Timeline,
  startDate: string
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // Sheet 1: 일정입력
  const rows = acts.map((a, i) => {
    const c = cpm.byId.get(a.id);
    return {
      No: i + 1,
      WBS: a.wbs || "",
      ID: a.id,
      활동명: a.name,
      담당부서: a.owner || "",
      "선행(관계·Lag)": (a.predecessors || [])
        .map((p) => `${p.activityId}(${p.relation}${p.lagMonths ? `,${p.lagMonths}` : ""})`)
        .join(", "),
      "기간(월)": fmtDur(a.durationMonths),
      "가장빠른착수(ES)": c?.es != null ? fmtISO(c.es) : "",
      "가장빠른완료(EF)": c?.ef != null ? fmtISO(c.ef) : "",
      "가장늦은착수(LS)": c?.ls != null ? fmtISO(c.ls) : "",
      "가장늦은완료(LF)": c?.lf != null ? fmtISO(c.lf) : "",
      "총여유 TF(일)": c?.tf ?? "",
      주공정: c?.critical ? "●" : "",
      오류: c?.error || "",
    };
  });
  const ws1 = XLSX.utils.json_to_sheet(rows);
  ws1["!cols"] = [
    { wch: 4 }, { wch: 8 }, { wch: 7 }, { wch: 24 }, { wch: 10 }, { wch: 28 },
    { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 11 }, { wch: 6 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, ws1, "일정입력");

  // Sheet 2: 간트차트
  const months = timeline.months;
  const mLabel = (m: number) => {
    const d = new Date(m);
    return `${String(d.getUTCFullYear()).slice(2)}.${pad2(d.getUTCMonth() + 1)}`;
  };
  const header = ["ID", "활동명", "기간(월)", ...months.map(mLabel)];
  const aoa: (string | number)[][] = [
    [`건설공정관리 간트차트 — 시작 ${startDate} / 완료 ${fmtISO(cpm.finishMs)}`],
    [],
    header,
  ];
  acts.forEach((a) => {
    const c = cpm.byId.get(a.id);
    const cells: (string | number)[] = [a.id, a.name, fmtDur(a.durationMonths)];
    months.forEach((m) => {
      if (!c || c.es == null || c.ef == null) { cells.push(""); return; }
      const mEnd = addDays(addCalMonths(m, 1), -1);
      if (c.ef < m || c.es > mEnd) { cells.push(""); return; }
      if ((a.durationMonths || 0) === 0) { cells.push("◆"); return; }
      cells.push("");
    });
    aoa.push(cells);
  });
  const ws2 = XLSX.utils.aoa_to_sheet(aoa);
  const C_CRIT = "C0392B", C_NORM = "3D6E96", C_MS = "E8A33D";
  acts.forEach((a, ai) => {
    const c = cpm.byId.get(a.id);
    if (!c || c.es == null || c.ef == null) return;
    const row = 3 + ai;
    months.forEach((m, mi) => {
      const mEnd = addDays(addCalMonths(m, 1), -1);
      if (c.ef! < m || c.es! > mEnd) return;
      const ref = XLSX.utils.encode_cell({ c: 3 + mi, r: row });
      const cell = ws2[ref];
      if (!cell) return;
      if ((a.durationMonths || 0) === 0) {
        cell.s = { fill: { patternType: "solid", fgColor: { rgb: C_MS } } };
      } else {
        cell.s = { fill: { patternType: "solid", fgColor: { rgb: c.critical ? C_CRIT : C_NORM } } };
      }
    });
  });
  ws2["!cols"] = [{ wch: 7 }, { wch: 24 }, { wch: 8 }, ...months.map(() => ({ wch: 5 }))];
  XLSX.utils.book_append_sheet(wb, ws2, "간트차트");

  return wb;
}
