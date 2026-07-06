"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  Activity,
  Relation,
  computeCPM,
  wouldCreateCycle,
  relationFromPorts,
  planMove,
  durationForRange,
  seedActivities,
  seedProject,
  parseISO,
  fmtISO,
  fmtShort,
  fmtDur,
  addDays,
  addCalMonths,
  addMonthsF,
  startOfMonth,
  todayUTC,
  pad2,
  eid,
  DAY,
} from "@/lib/cpm";
import { loadProject, saveProject } from "@/lib/storage";

/* ---------------- 상수 ---------------- */
const PX_PER_DAY = 1.9;
const ROW_H = 38;
const BAR_H = 18;
const LABEL_W = 236;
const HEADER_H = 36;
const REL_LABEL: Record<Relation, string> = {
  FS: "완료→시작",
  SS: "시작→시작",
  FF: "완료→완료",
  SF: "시작→완료",
};

const TERMS: [string, string][] = [
  ["FS (완료→시작)", "선행이 끝나야 후행이 시작. 가장 일반적인 관계 (기본값)"],
  ["SS (시작→시작)", "선행이 시작하면 후행도 시작 가능 (병행 착수)"],
  ["FF (완료→완료)", "선행이 끝나야 후행도 끝날 수 있음"],
  ["SF (시작→완료)", "선행이 시작해야 후행이 끝날 수 있음 (드묾)"],
  ["Lag", "선·후행 사이 지연 기간(개월). 0.5 = 약 15일"],
  ["ES / EF", "가장 빠른 착수일 / 가장 빠른 완료일"],
  ["LS / LF", "전체 공기를 지연시키지 않는 가장 늦은 착수일 / 완료일"],
  ["TF (총여유)", "LF − EF (일). 해당 활동이 지연돼도 되는 여유"],
  ["주공정 (CP)", "TF ≤ 0인 활동의 연결. 하루만 지연돼도 전체 준공이 지연"],
];
const USAGE = [
  "아래 일정입력 표에서 활동을 추가·수정하면 간트차트가 즉시 다시 계산됩니다. 두 화면은 같은 데이터입니다.",
  "간트 막대 드래그 = 착수일 이동 (선행 제약보다 앞당기면 자동 스냅, 늦추면 그 차이가 선행 관계의 Lag로 저장됨)",
  "막대 좌/우 끝단 드래그 = 소요기간 조정 · 막대 더블클릭 = 기간(월)을 숫자로 직접 입력",
  "막대에 마우스를 올리면 나타나는 ○ 커넥터를 다른 막대로 드래그 = 선후행 연결 (연결한 끝점 위치에 따라 FS/SS/FF/SF 자동 결정)",
  "연결선(화살표) 클릭 = 관계유형·Lag 수정 또는 삭제 (Delete 키 가능)",
  '우측 상단 "엑셀 내보내기" = 일정표·간트차트 2개 시트로 저장 · 하단 "AI 분석" = 공정 지연·비용 리스크와 대응방안 제안',
];

interface Toast {
  msg: string;
  kind: "info" | "warn" | "error";
}
interface DragState {
  mode: "move" | "resize-l" | "resize-r" | "connect";
  id: string;
  side?: "start" | "finish";
  startX: number;
  curX: number;
  curY: number;
  origEs: number;
  origEf: number;
  fromSide?: "start" | "finish";
}
interface SelEdge {
  succId: string;
  edgeId: string;
  x: number;
  y: number;
}
interface DurEdit {
  id: string;
  x: number;
  y: number;
  val: string;
}
interface Risk {
  category: string;
  severity: string;
  title: string;
  description: string;
  mitigation: string;
  relatedIds?: string[];
}
interface AiState {
  open: boolean;
  loading: boolean;
  result: { summary?: string; risks?: Risk[] } | null;
  error: string | null;
}

export default function Scheduler() {
  const [project, setProject] = useState(seedProject);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selEdge, setSelEdge] = useState<SelEdge | null>(null);
  const [predAddRow, setPredAddRow] = useState<string | null>(null);
  const [predForm, setPredForm] = useState<{ activityId: string; relation: Relation; lagMonths: number | string }>({
    activityId: "",
    relation: "FS",
    lagMonths: 0,
  });
  const [ai, setAi] = useState<AiState>({ open: false, loading: false, result: null, error: null });
  const [durEdit, setDurEdit] = useState<DurEdit | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((msg: string, kind: "info" | "warn" | "error" = "info") => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  /* --- 저장/불러오기 --- */
  useEffect(() => {
    const p = loadProject();
    if (p) setProject(p);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => saveProject(project), 500);
    return () => clearTimeout(t);
  }, [project, loaded]);

  /* --- 계산 --- */
  const startMs = useMemo(() => parseISO(project.startDate), [project.startDate]);
  const cpm = useMemo(() => computeCPM(project.activities, startMs), [project.activities, startMs]);
  const acts = project.activities;
  const critCount = acts.filter((a) => cpm.byId.get(a.id)?.critical).length;
  const errCount = acts.filter((a) => cpm.byId.get(a.id)?.error).length;
  const totalMonths = ((cpm.finishMs - startMs) / DAY / 30.44).toFixed(1);

  const applyActivities = useCallback(
    (newActs: Activity[], newStartISO?: string) => {
      const before = computeCPM(acts, startMs);
      const after = computeCPM(newActs, newStartISO ? parseISO(newStartISO) : startMs);
      const moved = new Set<string>();
      newActs.forEach((a) => {
        const b = before.byId.get(a.id),
          f = after.byId.get(a.id);
        if (b && f && (b.es !== f.es || b.ef !== f.ef)) moved.add(a.id);
      });
      setProject((p) => ({ ...p, startDate: newStartISO || p.startDate, activities: newActs }));
      setHighlight(moved);
      clearTimeout(hlTimer.current);
      hlTimer.current = setTimeout(() => setHighlight(new Set()), 1600);
    },
    [acts, startMs]
  );

  /* --- 테이블 편집 --- */
  const patchAct = (id: string, patch: Partial<Activity>) =>
    applyActivities(acts.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const commitId = (oldId: string, raw: string) => {
    const newId = raw.trim();
    if (!newId || newId === oldId) return;
    if (acts.some((a) => a.id === newId)) {
      showToast(`ID "${newId}"가 이미 존재합니다`, "error");
      return;
    }
    applyActivities(
      acts.map((a) => ({
        ...a,
        id: a.id === oldId ? newId : a.id,
        predecessors: (a.predecessors || []).map((p) =>
          p.activityId === oldId ? { ...p, activityId: newId } : p
        ),
      }))
    );
  };
  const nextId = () => {
    let n = 10;
    while (acts.some((a) => a.id === `A${String(n).padStart(3, "0")}`)) n += 10;
    return `A${String(n).padStart(3, "0")}`;
  };
  const addRow = () =>
    applyActivities([
      ...acts,
      { id: nextId(), wbs: "", name: "새 활동", owner: "", predecessors: [], durationMonths: 1 },
    ]);
  const dupRow = (id: string) => {
    const src = acts.find((a) => a.id === id)!;
    const i = acts.findIndex((a) => a.id === id);
    const copy: Activity = {
      ...src,
      id: nextId(),
      name: src.name + " (복제)",
      predecessors: src.predecessors.map((p) => ({ ...p, id: eid() })),
    };
    applyActivities([...acts.slice(0, i + 1), copy, ...acts.slice(i + 1)]);
  };
  const delRow = (id: string) =>
    applyActivities(
      acts
        .filter((a) => a.id !== id)
        .map((a) => ({ ...a, predecessors: a.predecessors.filter((p) => p.activityId !== id) }))
    );
  const removePred = (actId: string, edgeId: string) =>
    applyActivities(
      acts.map((a) => (a.id !== actId ? a : { ...a, predecessors: a.predecessors.filter((p) => p.id !== edgeId) }))
    );
  const addPred = (actId: string) => {
    const { activityId, relation, lagMonths } = predForm;
    if (!activityId) {
      showToast("선행 활동을 선택하세요", "error");
      return;
    }
    if (wouldCreateCycle(acts, activityId, actId)) {
      showToast("순환참조가 발생하여 연결할 수 없습니다", "error");
      return;
    }
    applyActivities(
      acts.map((a) => {
        if (a.id !== actId) return a;
        const exist = a.predecessors.find((p) => p.activityId === activityId);
        if (exist)
          return {
            ...a,
            predecessors: a.predecessors.map((p) =>
              p === exist ? { ...p, relation, lagMonths: Number(lagMonths) || 0 } : p
            ),
          };
        return {
          ...a,
          predecessors: [...a.predecessors, { id: eid(), activityId, relation, lagMonths: Number(lagMonths) || 0 }],
        };
      })
    );
    setPredAddRow(null);
    setPredForm({ activityId: "", relation: "FS", lagMonths: 0 });
  };

  /* --- 간트 타임라인 --- */
  const timeline = useMemo(() => {
    let minT = Math.min(startMs, todayUTC());
    let maxT = Math.max(cpm.finishMs, addMonthsF(startMs, 6), todayUTC());
    acts.forEach((a) => {
      const c = cpm.byId.get(a.id);
      if (c && c.es != null && c.ef != null) {
        minT = Math.min(minT, c.es);
        maxT = Math.max(maxT, c.ef);
      }
    });
    const t0 = startOfMonth(addCalMonths(minT, -1));
    const t1 = startOfMonth(addCalMonths(maxT, 2));
    const months: number[] = [];
    let m = t0;
    while (m < t1) {
      months.push(m);
      m = addCalMonths(m, 1);
    }
    return { t0, t1, months };
  }, [startMs, cpm, acts]);
  const X = useCallback((t: number) => ((t - timeline.t0) / DAY) * PX_PER_DAY, [timeline.t0]);
  const chartW = X(timeline.t1);
  const chartH = acts.length * ROW_H + 8;

  const barGeom = useCallback(
    (a: Activity) => {
      const c = cpm.byId.get(a.id);
      if (!c || c.es == null || c.ef == null) return null;
      const xs = X(c.es);
      const xe = X(c.ef + DAY);
      return { xs, xe, w: Math.max(2, xe - xs) };
    },
    [cpm, X]
  );
  const rowY = (i: number) => i * ROW_H + (ROW_H - BAR_H) / 2 + 4;
  const rowIndex = useMemo(() => new Map(acts.map((a, i) => [a.id, i])), [acts]);

  /* --- 드래그 처리 --- */
  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startDrag = (
    e: React.PointerEvent,
    mode: DragState["mode"],
    a: Activity,
    side?: "start" | "finish"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const c = cpm.byId.get(a.id);
    if (!c || c.es == null || c.ef == null) return;
    const p = svgPoint(e);
    setSelEdge(null);
    setDrag({ mode, id: a.id, side, startX: p.x, curX: p.x, curY: p.y, origEs: c.es, origEf: c.ef, fromSide: side });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const p = svgPoint(e);
      setDrag((d) => (d ? { ...d, curX: p.x, curY: p.y } : d));
    };
    const up = (e: PointerEvent) => {
      const p = svgPoint(e);
      finishDrag({ ...drag, curX: p.x, curY: p.y });
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, acts, startMs, cpm, timeline]);

  const ghost = useMemo(() => {
    if (!drag) return null;
    const dx = drag.curX - drag.startX;
    const dd = Math.round(dx / PX_PER_DAY) * DAY;
    if (drag.mode === "move") return { es: drag.origEs + dd, ef: drag.origEf + dd };
    if (drag.mode === "resize-r") return { es: drag.origEs, ef: Math.max(drag.origEs, drag.origEf + dd) };
    if (drag.mode === "resize-l") return { es: Math.min(drag.origEf, drag.origEs + dd), ef: drag.origEf };
    return null;
  }, [drag]);

  const finishDrag = (d: DragState) => {
    if (!d) return;
    const dx = d.curX - d.startX;
    const dd = Math.round(dx / PX_PER_DAY) * DAY;
    if (d.mode === "connect") {
      finishConnect(d);
      return;
    }
    if (Math.abs(dd) < DAY) return;

    if (d.mode === "move") {
      const target = d.origEs + dd;
      const plan = planMove(acts, startMs, d.id, target);
      if (plan.type === "snap") {
        showToast("선행 제약으로 인해 더 앞당길 수 없습니다", "warn");
      } else if (plan.type === "moveProject") {
        applyActivities(acts, fmtISO(plan.newProjectStart));
        showToast(`프로젝트 시작일이 ${fmtShort(plan.newProjectStart)}(으)로 변경되었습니다`);
      } else if (plan.type === "lag") {
        applyActivities(plan.activities);
        showToast(`선행 관계 Lag이 ${plan.newLag.toFixed(2)}개월로 조정되었습니다`);
      }
    } else if (d.mode === "resize-r") {
      const targetEnd = Math.max(d.origEs, d.origEf + dd);
      const dur = durationForRange(d.origEs, targetEnd);
      applyActivities(acts.map((a) => (a.id === d.id ? { ...a, durationMonths: dur } : a)));
      showToast(`소요기간이 ${dur.toFixed(2)}개월로 변경되었습니다`);
    } else if (d.mode === "resize-l") {
      const target = Math.min(d.origEf, d.origEs + dd);
      const plan = planMove(acts, startMs, d.id, target);
      let base = acts;
      let newStartISO: string | undefined;
      let actualStart = target;
      if (plan.type === "snap") {
        actualStart = plan.snapTo;
        showToast("선행 제약으로 인해 더 앞당길 수 없습니다", "warn");
      } else if (plan.type === "moveProject") {
        newStartISO = fmtISO(plan.newProjectStart);
      } else if (plan.type === "lag") {
        base = plan.activities;
      }
      const dur = durationForRange(actualStart, d.origEf);
      applyActivities(
        base.map((a) => (a.id === d.id ? { ...a, durationMonths: dur } : a)),
        newStartISO
      );
    }
  };

  /* --- 마우스 선후행 연결 --- */
  const hitBar = (x: number, y: number): { id: string; side: "start" | "finish" } | null => {
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const g = barGeom(a);
      if (!g) continue;
      const by = rowY(i);
      if (y >= by - 8 && y <= by + BAR_H + 8 && x >= g.xs - 14 && x <= g.xe + 14) {
        const side = x < (g.xs + g.xe) / 2 ? "start" : "finish";
        return { id: a.id, side };
      }
    }
    return null;
  };
  const finishConnect = (d: DragState) => {
    const target = hitBar(d.curX, d.curY);
    if (!target || target.id === d.id) return;
    const relation = relationFromPorts(d.fromSide!, target.side);
    if (wouldCreateCycle(acts, d.id, target.id)) {
      showToast("순환참조가 발생하여 연결이 취소되었습니다", "error");
      return;
    }
    applyActivities(
      acts.map((a) => {
        if (a.id !== target.id) return a;
        const exist = a.predecessors.find((p) => p.activityId === d.id);
        if (exist)
          return { ...a, predecessors: a.predecessors.map((p) => (p === exist ? { ...p, relation } : p)) };
        return { ...a, predecessors: [...a.predecessors, { id: eid(), activityId: d.id, relation, lagMonths: 0 }] };
      })
    );
    showToast(`${d.id} → ${target.id} 연결 생성 (${relation})`);
  };

  /* --- Delete 키 --- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (selEdge) {
        removePred(selEdge.succId, selEdge.edgeId);
        setSelEdge(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selEdge, acts]);
  const patchEdge = (succId: string, edgeId: string, patch: Partial<{ relation: Relation; lagMonths: number }>) =>
    applyActivities(
      acts.map((a) =>
        a.id !== succId
          ? a
          : { ...a, predecessors: a.predecessors.map((p) => (p.id === edgeId ? { ...p, ...patch } : p)) }
      )
    );

  /* --- 막대 더블클릭 → 기간 입력 --- */
  const openDurEdit = (a: Activity, i: number) => {
    const g = barGeom(a);
    if (!g) return;
    setDurEdit({ id: a.id, x: Math.max(0, g.xs), y: HEADER_H + rowY(i) - 3, val: String(fmtDur(a.durationMonths)) });
  };
  const commitDurEdit = () => {
    if (!durEdit) return;
    const v = Math.max(0, Number(durEdit.val));
    if (!Number.isNaN(v)) {
      patchAct(durEdit.id, { durationMonths: v });
      showToast(`${durEdit.id} 소요기간을 ${fmtDur(v)}개월로 변경했습니다`);
    }
    setDurEdit(null);
  };

  /* --- 엑셀 내보내기 --- */
  const exportExcel = () => {
    try {
      const wb = XLSX.utils.book_new();
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

      const months = timeline.months;
      const mLabel = (m: number) => {
        const d = new Date(m);
        return `${String(d.getUTCFullYear()).slice(2)}.${pad2(d.getUTCMonth() + 1)}`;
      };
      const header = ["ID", "활동명", "기간(월)", ...months.map(mLabel)];
      const aoa: (string | number)[][] = [
        [`건설공정관리 간트차트 — 시작 ${project.startDate} / 완료 ${fmtISO(cpm.finishMs)}`],
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

      XLSX.writeFile(wb, "건설공정관리.xlsx", { cellStyles: true });
      showToast("엑셀 파일을 내보냈습니다 (일정입력 + 간트차트)");
    } catch {
      showToast("엑셀 내보내기에 실패했습니다", "error");
    }
  };

  /* --- AI 리스크 분석 (서버 API 호출) --- */
  const runAI = async () => {
    setAi({ open: true, loading: true, result: null, error: null });
    try {
      const rows = acts
        .map((a) => {
          const c = cpm.byId.get(a.id);
          const preds =
            (a.predecessors || [])
              .map((p) => `${p.activityId}(${p.relation}${p.lagMonths ? `,lag ${p.lagMonths}개월` : ""})`)
              .join(" / ") || "-";
          return `${a.id} | ${a.name} | 공종:${a.wbs || "-"} | 담당부서:${a.owner || "-"} | 기간 ${a.durationMonths}개월 | 선행: ${preds} | ES ${fmtShort(c?.es)} ~ EF ${fmtShort(c?.ef)} | 총여유 ${c?.tf ?? "-"}일 | ${c?.critical ? "★주공정" : ""} ${c?.error ? `오류:${c.error}` : ""}`;
        })
        .join("\n");
      const criticalPath = acts
        .filter((a) => cpm.byId.get(a.id)?.critical)
        .map((a) => a.id)
        .join(" → ");

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: project.startDate,
          finishDate: fmtISO(cpm.finishMs),
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
      if (data.risks || data.summary) setAi({ open: true, loading: false, result: data, error: null });
      else throw new Error("응답이 비어 있습니다");
    } catch (e) {
      setAi({
        open: true,
        loading: false,
        result: null,
        error: e instanceof Error ? e.message : "AI 분석에 실패했습니다. 잠시 후 다시 시도하세요.",
      });
    }
  };

  /* --- 연결선 좌표 --- */
  const edgePath = (predA: Activity, succA: Activity, edge: { relation: Relation }) => {
    const pi = rowIndex.get(predA.id),
      si = rowIndex.get(succA.id);
    const pg = barGeom(predA),
      sg = barGeom(succA);
    if (pg == null || sg == null || pi == null || si == null) return null;
    const py = rowY(pi) + BAR_H / 2,
      sy = rowY(si) + BAR_H / 2;
    const fromStart = edge.relation === "SS" || edge.relation === "SF";
    const toStart = edge.relation === "FS" || edge.relation === "SS";
    const x1 = fromStart ? pg.xs : pg.xe;
    const x2 = toStart ? sg.xs : sg.xe;
    const stub = 10;
    const a1 = x1 + (fromStart ? -stub : stub);
    const a2 = x2 + (toStart ? -stub : stub);
    const midY = sy > py ? sy - BAR_H / 2 - 4 : sy + BAR_H / 2 + 4;
    const d = `M ${x1} ${py} L ${a1} ${py} L ${a1} ${midY} L ${a2} ${midY} L ${a2} ${sy} L ${x2} ${sy}`;
    return { d };
  };

  /* ================= 렌더 ================= */
  const inputCls =
    "border border-stone-300 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-sky-600 w-full";
  const monoCls = "font-mono text-[11px] tabular-nums";
  const sectionTitle = "px-4 py-2.5 text-sm font-bold border-b border-stone-200 flex items-center justify-between";

  const dash: [string, string, boolean?, string?][] = [
    ["프로젝트 완료일 (자동)", fmtISO(cpm.finishMs), true],
    ["총공기", `${totalMonths} 개월`],
    ["전체 활동", `${acts.length} 개`],
    ["주공정 활동", `${critCount} 개`, false, "#C0392B"],
  ];

  return (
    <div
      className="min-h-screen pb-28"
      style={{ background: "#F3F2ED", color: "#232A33" }}
    >
      {/* 헤더 */}
      <header
        className="px-5 py-4 flex items-end justify-between flex-wrap gap-2"
        style={{ background: "#20303F", color: "#F2EFE7" }}
      >
        <div>
          <div className="text-[11px] tracking-[0.25em] opacity-70 font-mono">CRITICAL PATH METHOD</div>
          <h1 className="text-xl font-bold mt-0.5">건설공정관리</h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportExcel}
            className="text-xs px-3 py-1.5 rounded font-semibold"
            style={{ background: "#3E7A3A", color: "#fff" }}
          >
            ⬇ 엑셀 내보내기
          </button>
          <button
            onClick={() => {
              applyActivities(seedActivities(), "2026-07-01");
              showToast("샘플 데이터로 재설정했습니다");
            }}
            className="text-xs px-3 py-1.5 rounded border border-white/30 hover:bg-white/10"
          >
            샘플로 재설정
          </button>
        </div>
      </header>

      {/* 사용법 · 용어설명 */}
      <section className="px-5 pt-3">
        <div className="bg-white border border-stone-300 rounded-lg overflow-hidden">
          <button
            onClick={() => setGuideOpen((v) => !v)}
            className="w-full text-left px-4 py-2.5 text-sm font-bold flex justify-between items-center hover:bg-stone-50"
          >
            <span>사용법 · 용어설명</span>
            <span className="text-stone-400 text-xs">{guideOpen ? "▲ 접기" : "▼ 펼치기"}</span>
          </button>
          {guideOpen && (
            <div className="px-4 pb-4 grid md:grid-cols-2 gap-5 border-t border-stone-200 pt-3">
              <div>
                <div className="text-[11px] font-bold tracking-widest text-stone-400 mb-2">사용법</div>
                <ol className="space-y-1.5 text-xs text-stone-700 list-decimal list-inside leading-relaxed">
                  {USAGE.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ol>
              </div>
              <div>
                <div className="text-[11px] font-bold tracking-widest text-stone-400 mb-2">용어설명</div>
                <dl className="text-xs space-y-1">
                  {TERMS.map(([t, d]) => (
                    <div key={t} className="flex gap-2">
                      <dt className="font-mono font-semibold shrink-0 w-28" style={{ color: "#2F6C93" }}>
                        {t}
                      </dt>
                      <dd className="text-stone-700 leading-relaxed">{d}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 대시보드 */}
      <section className="px-5 py-3 flex flex-wrap gap-3 items-stretch">
        <div className="bg-white rounded-lg border border-stone-300 px-4 py-2.5">
          <div className="text-[11px] text-stone-500">프로젝트 시작일</div>
          <input
            type="date"
            value={project.startDate}
            onChange={(e) => e.target.value && applyActivities(acts, e.target.value)}
            className="font-mono text-sm font-semibold bg-transparent focus:outline-none"
          />
        </div>
        {dash.map(([label, val, mono, color]) => (
          <div key={label} className="bg-white rounded-lg border border-stone-300 px-4 py-2.5">
            <div className="text-[11px] text-stone-500">{label}</div>
            <div className={`text-sm font-semibold ${mono ? "font-mono" : ""}`} style={color ? { color } : {}}>
              {val}
            </div>
          </div>
        ))}
        {errCount > 0 && (
          <div className="rounded-lg border px-4 py-2.5" style={{ background: "#FCEBEA", borderColor: "#E4A6A2" }}>
            <div className="text-[11px]" style={{ color: "#9A3730" }}>
              계산 오류
            </div>
            <div className="text-sm font-semibold" style={{ color: "#C0392B" }}>
              {errCount}개 활동 확인 필요
            </div>
          </div>
        )}
      </section>

      <main className="px-5 space-y-4">
        {/* ===== 간트차트 ===== */}
        <div className="bg-white border border-stone-300 rounded-lg overflow-hidden">
          <div className={sectionTitle}>
            <span>간트차트</span>
            <span className="text-[11px] font-normal text-stone-500 flex flex-wrap gap-x-3">
              <span>
                <span className="inline-block w-3 h-2.5 rounded-sm align-middle mr-1" style={{ background: "#C0392B" }} />
                주공정
              </span>
              <span>
                <span className="inline-block w-3 h-2.5 rounded-sm align-middle mr-1" style={{ background: "#3D6E96" }} />
                일반
              </span>
              <span>◆ 마일스톤</span>
              <span className="text-stone-400 hidden sm:inline">막대 더블클릭 = 기간 입력</span>
            </span>
          </div>
          <div className="flex">
            {/* 좌측 라벨 */}
            <div className="shrink-0 border-r border-stone-200" style={{ width: LABEL_W }}>
              <div
                className="border-b border-stone-200 flex items-center px-3 text-[11px] font-semibold text-stone-500 bg-stone-50"
                style={{ height: HEADER_H }}
              >
                활동
              </div>
              {acts.map((a, i) => {
                const c = cpm.byId.get(a.id);
                return (
                  <div
                    key={a.id}
                    onMouseEnter={() => setHoverRow(a.id)}
                    onMouseLeave={() => setHoverRow(null)}
                    className={`flex items-center gap-2 px-3 border-b border-stone-100 ${
                      c?.critical ? "bg-red-50" : i % 2 ? "bg-stone-50/50" : ""
                    }`}
                    style={{ height: ROW_H }}
                  >
                    <span className={`${monoCls} text-stone-500 w-11 shrink-0`}>{a.id}</span>
                    <span className="text-xs truncate" title={a.name}>
                      {a.name}
                    </span>
                    {c?.error && (
                      <span title={c.error} className="text-amber-600 text-xs cursor-help">
                        ⚠
                      </span>
                    )}
                    {c?.critical && (
                      <span className="ml-auto text-[10px] font-bold" style={{ color: "#C0392B" }}>
                        CP
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 우측 차트 */}
            <div className="overflow-x-auto grow">
              <div style={{ width: chartW, position: "relative" }}>
                <div className="border-b border-stone-200 relative bg-stone-50" style={{ width: chartW, height: HEADER_H }}>
                  {timeline.months.map((m) => (
                    <div
                      key={m}
                      className="absolute top-0 h-full border-l border-stone-200 flex items-center justify-center text-[10px] font-mono text-stone-500"
                      style={{ left: X(m), width: X(addCalMonths(m, 1)) - X(m) }}
                    >
                      {String(new Date(m).getUTCFullYear()).slice(2)}.{pad2(new Date(m).getUTCMonth() + 1)}
                    </div>
                  ))}
                </div>
                <svg ref={svgRef} width={chartW} height={chartH} style={{ display: "block", touchAction: "none" }}>
                  <defs>
                    <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill="#9C968A" />
                    </marker>
                    <marker id="arrC" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill="#C0392B" />
                    </marker>
                  </defs>
                  {timeline.months.map((m) => (
                    <line key={m} x1={X(m)} x2={X(m)} y1={0} y2={chartH} stroke="#EBE9E2" />
                  ))}
                  {acts.map((a, i) => {
                    const c = cpm.byId.get(a.id);
                    return (
                      <rect
                        key={a.id}
                        x={0}
                        y={i * ROW_H + 4}
                        width={chartW}
                        height={ROW_H}
                        fill={c?.critical ? "rgba(214,69,61,0.05)" : i % 2 ? "rgba(0,0,0,0.015)" : "transparent"}
                        onMouseEnter={() => setHoverRow(a.id)}
                      />
                    );
                  })}
                  {/* 연결선 */}
                  {acts.map((succ) =>
                    (succ.predecessors || []).map((p) => {
                      const pred = acts.find((x) => x.id === p.activityId);
                      if (!pred) return null;
                      const ep = edgePath(pred, succ, p);
                      if (!ep) return null;
                      const crit = cpm.byId.get(pred.id)?.critical && cpm.byId.get(succ.id)?.critical;
                      const sel = selEdge && selEdge.edgeId === p.id;
                      return (
                        <g key={p.id}>
                          <path
                            d={ep.d}
                            fill="none"
                            stroke={sel ? "#1B6FA8" : crit ? "#C0392B" : "#B9B4A8"}
                            strokeWidth={sel ? 2.5 : crit ? 2 : 1.3}
                            markerEnd={`url(#${crit ? "arrC" : "arr"})`}
                          />
                          <path
                            d={ep.d}
                            fill="none"
                            stroke="transparent"
                            strokeWidth={10}
                            style={{ cursor: "pointer" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              const pt = svgPoint(e);
                              setSelEdge({ succId: succ.id, edgeId: p.id, x: pt.x, y: pt.y });
                            }}
                          >
                            <title>
                              {pred.id} → {succ.id} · {p.relation}
                              {p.lagMonths ? ` +${p.lagMonths}개월` : ""} (클릭하여 수정)
                            </title>
                          </path>
                        </g>
                      );
                    })
                  )}
                  {/* 활동 막대 */}
                  {acts.map((a, i) => {
                    const c = cpm.byId.get(a.id);
                    const g = barGeom(a);
                    if (!c || !g) return null;
                    const y = rowY(i);
                    const isMs = (a.durationMonths || 0) === 0;
                    const color = c.critical ? "#C0392B" : "#3D6E96";
                    const hov = hoverRow === a.id || (drag && drag.id === a.id);
                    const hl = highlight.has(a.id);
                    const durLabel = `${fmtDur(a.durationMonths)}개월`;
                    const labelInside = g.w >= durLabel.length * 7 + 14;
                    return (
                      <g key={a.id} onMouseEnter={() => setHoverRow(a.id)} className={hl ? "bar-hl" : ""}>
                        {isMs ? (
                          <path
                            d={`M ${g.xs} ${y - 2} l 10 ${BAR_H / 2 + 2} l -10 ${BAR_H / 2 + 2} l -10 ${-(BAR_H / 2 + 2)} z`}
                            fill={color}
                            style={{ cursor: "grab" }}
                            onPointerDown={(e) => startDrag(e, "move", a)}
                            onDoubleClick={() => openDurEdit(a, i)}
                          >
                            <title>
                              {a.id} {a.name} · {fmtShort(c.es)} · 마일스톤 · 여유 {c.tf}일 (더블클릭=기간 입력)
                            </title>
                          </path>
                        ) : (
                          <g>
                            <rect
                              x={g.xs}
                              y={y}
                              width={g.w}
                              height={BAR_H}
                              rx={3}
                              fill={color}
                              opacity={0.92}
                              style={{ cursor: "grab" }}
                              onPointerDown={(e) => startDrag(e, "move", a)}
                              onDoubleClick={() => openDurEdit(a, i)}
                            >
                              <title>
                                {a.id} {a.name}
                                {"\n"}
                                {fmtShort(c.es)} ~ {fmtShort(c.ef)} · {fmtDur(a.durationMonths)}개월 · 총여유 {c.tf}일
                                {c.critical ? " · 주공정" : ""}
                                {"\n"}더블클릭하면 기간을 직접 입력할 수 있습니다
                              </title>
                            </rect>
                            {labelInside ? (
                              <text
                                x={g.xs + g.w / 2}
                                y={y + BAR_H / 2 + 3.5}
                                textAnchor="middle"
                                fontSize={10}
                                fontWeight="bold"
                                fill="#fff"
                                pointerEvents="none"
                              >
                                {durLabel}
                              </text>
                            ) : (
                              <text
                                x={g.xe + 14}
                                y={y + BAR_H / 2 + 3.5}
                                fontSize={10}
                                fontWeight="bold"
                                fill="#57606A"
                                pointerEvents="none"
                              >
                                {durLabel}
                              </text>
                            )}
                            <rect
                              x={g.xs}
                              y={y}
                              width={6}
                              height={BAR_H}
                              fill="rgba(255,255,255,0.001)"
                              style={{ cursor: "col-resize" }}
                              onPointerDown={(e) => startDrag(e, "resize-l", a)}
                            />
                            <rect
                              x={g.xe - 6}
                              y={y}
                              width={6}
                              height={BAR_H}
                              fill="rgba(255,255,255,0.001)"
                              style={{ cursor: "col-resize" }}
                              onPointerDown={(e) => startDrag(e, "resize-r", a)}
                            />
                          </g>
                        )}
                        {(hov || (drag && drag.mode === "connect")) && (
                          <g>
                            <circle
                              cx={g.xs - 8}
                              cy={y + BAR_H / 2}
                              r={5}
                              fill="#fff"
                              stroke="#2F6C93"
                              strokeWidth={1.6}
                              style={{ cursor: "crosshair" }}
                              onPointerDown={(e) => startDrag(e, "connect", a, "start")}
                            >
                              <title>시작점 커넥터 — 드래그하여 선후행 연결</title>
                            </circle>
                            <circle
                              cx={g.xe + 8}
                              cy={y + BAR_H / 2}
                              r={5}
                              fill="#fff"
                              stroke="#2F6C93"
                              strokeWidth={1.6}
                              style={{ cursor: "crosshair" }}
                              onPointerDown={(e) => startDrag(e, "connect", a, "finish")}
                            >
                              <title>종료점 커넥터 — 드래그하여 선후행 연결</title>
                            </circle>
                          </g>
                        )}
                      </g>
                    );
                  })}
                  {/* 고스트 바 */}
                  {drag &&
                    ghost &&
                    drag.mode !== "connect" &&
                    (() => {
                      const i = rowIndex.get(drag.id)!;
                      const xs = X(ghost.es),
                        xe = X(ghost.ef + DAY);
                      return (
                        <g pointerEvents="none">
                          <rect
                            x={xs}
                            y={rowY(i)}
                            width={Math.max(2, xe - xs)}
                            height={BAR_H}
                            rx={3}
                            fill="#2F6C93"
                            opacity={0.35}
                            stroke="#2F6C93"
                            strokeDasharray="4 3"
                          />
                          <rect x={drag.curX + 10} y={rowY(i) - 22} width={150} height={18} rx={4} fill="#20303F" />
                          <text x={drag.curX + 16} y={rowY(i) - 9} fill="#fff" fontSize={10} fontFamily="monospace">
                            {fmtShort(ghost.es)} ~ {fmtShort(ghost.ef)}
                          </text>
                        </g>
                      );
                    })()}
                  {/* 연결 임시선 */}
                  {drag &&
                    drag.mode === "connect" &&
                    (() => {
                      const i = rowIndex.get(drag.id)!;
                      const g = barGeom(acts[i]);
                      if (!g) return null;
                      const x0 = drag.fromSide === "start" ? g.xs - 8 : g.xe + 8;
                      const y0 = rowY(i) + BAR_H / 2;
                      return (
                        <line
                          x1={x0}
                          y1={y0}
                          x2={drag.curX}
                          y2={drag.curY}
                          stroke="#2F6C93"
                          strokeWidth={2}
                          strokeDasharray="5 4"
                          pointerEvents="none"
                        />
                      );
                    })()}
                  {/* 오늘선 */}
                  {(() => {
                    const t = todayUTC();
                    if (t < timeline.t0 || t > timeline.t1) return null;
                    return (
                      <g pointerEvents="none">
                        <line x1={X(t)} x2={X(t)} y1={0} y2={chartH} stroke="#E8A33D" strokeWidth={1.6} strokeDasharray="3 3" />
                        <rect x={X(t) - 15} y={2} width={30} height={14} rx={3} fill="#E8A33D" />
                        <text x={X(t)} y={12.5} textAnchor="middle" fontSize={9} fill="#fff" fontWeight="bold">
                          오늘
                        </text>
                      </g>
                    );
                  })()}
                </svg>
                {durEdit && (
                  <div
                    style={{ position: "absolute", left: durEdit.x, top: durEdit.y, zIndex: 20 }}
                    className="flex items-center gap-1 bg-white border-2 border-sky-700 rounded shadow-lg px-1.5 py-1"
                  >
                    <input
                      autoFocus
                      type="number"
                      step="0.5"
                      min="0"
                      value={durEdit.val}
                      onChange={(e) => setDurEdit((d) => (d ? { ...d, val: e.target.value } : d))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitDurEdit();
                        if (e.key === "Escape") setDurEdit(null);
                      }}
                      onBlur={commitDurEdit}
                      className="w-16 text-xs font-mono focus:outline-none"
                    />
                    <span className="text-[10px] text-stone-500">개월</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          {selEdge &&
            (() => {
              const succ = acts.find((a) => a.id === selEdge.succId);
              const edge = succ?.predecessors.find((p) => p.id === selEdge.edgeId);
              if (!edge) return null;
              return (
                <div
                  className="fixed z-40 bg-white border border-stone-300 rounded-lg shadow-lg p-3 text-xs w-64"
                  style={{
                    left: Math.min(selEdge.x + LABEL_W + 20, (typeof window !== "undefined" ? window.innerWidth : 800) - 280),
                    top: 340,
                  }}
                >
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold">
                      {edge.activityId} → {selEdge.succId}
                    </span>
                    <button onClick={() => setSelEdge(null)} className="text-stone-400 hover:text-stone-700">
                      ✕
                    </button>
                  </div>
                  <div className="flex gap-2 items-center mb-2">
                    <label className="w-14 text-stone-500">관계</label>
                    <select
                      value={edge.relation}
                      onChange={(e) => patchEdge(selEdge.succId, edge.id, { relation: e.target.value as Relation })}
                      className={inputCls}
                    >
                      {(["FS", "SS", "FF", "SF"] as Relation[]).map((r) => (
                        <option key={r} value={r}>
                          {r} · {REL_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2 items-center mb-3">
                    <label className="w-14 text-stone-500">Lag(월)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={edge.lagMonths}
                      onChange={(e) => patchEdge(selEdge.succId, edge.id, { lagMonths: Number(e.target.value) || 0 })}
                      className={inputCls}
                    />
                  </div>
                  <button
                    onClick={() => {
                      removePred(selEdge.succId, edge.id);
                      setSelEdge(null);
                    }}
                    className="w-full py-1.5 rounded border border-red-300 text-red-600 hover:bg-red-50"
                  >
                    연결 삭제 (Delete 키)
                  </button>
                </div>
              );
            })()}
        </div>

        {/* ===== 일정입력 ===== */}
        <div className="bg-white border border-stone-300 rounded-lg overflow-hidden">
          <div className={sectionTitle}>
            <span>일정입력</span>
            <button onClick={addRow} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: "#2F6C93" }}>
              ＋ 행 추가
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs whitespace-nowrap border-collapse min-w-full">
              <thead>
                <tr className="bg-stone-100 text-stone-600 text-[11px]">
                  {[
                    "No",
                    "WBS",
                    "ID",
                    "활동명",
                    "담당부서",
                    "선행 (관계·Lag)",
                    "기간(월)",
                    "가장빠른착수 ES",
                    "가장빠른완료 EF",
                    "가장늦은착수 LS",
                    "가장늦은완료 LF",
                    "총여유 TF(일)",
                    "주공정",
                    "관리",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 border-b border-stone-300 font-semibold text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {acts.map((a, i) => {
                  const c = cpm.byId.get(a.id);
                  return (
                    <tr key={a.id} className={`border-b border-stone-100 ${c?.critical ? "bg-red-50" : ""}`}>
                      <td className="px-2 py-1.5 text-stone-400">{i + 1}</td>
                      <td className="px-2 py-1.5">
                        <input value={a.wbs || ""} onChange={(e) => patchAct(a.id, { wbs: e.target.value })} className={inputCls} style={{ width: 70 }} />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <input
                            key={a.id}
                            defaultValue={a.id}
                            onBlur={(e) => commitId(a.id, e.target.value)}
                            className={`${inputCls} font-mono`}
                            style={{ width: 60 }}
                          />
                          {c?.error && (
                            <span title={c.error} className="text-amber-600 cursor-help">
                              ⚠
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <input value={a.name} onChange={(e) => patchAct(a.id, { name: e.target.value })} className={inputCls} style={{ width: 160 }} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={a.owner || ""}
                          onChange={(e) => patchAct(a.id, { owner: e.target.value })}
                          className={inputCls}
                          style={{ width: 80 }}
                          placeholder="담당부서"
                        />
                      </td>
                      <td className="px-2 py-1.5" style={{ maxWidth: 280 }}>
                        <div className="flex flex-wrap gap-1 items-center">
                          {(a.predecessors || []).map((p) => (
                            <span
                              key={p.id}
                              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 border ${
                                acts.some((x) => x.id === p.activityId)
                                  ? "bg-sky-50 border-sky-200 text-sky-900"
                                  : "bg-red-50 border-red-300 text-red-700"
                              }`}
                            >
                              <span className="font-mono">{p.activityId}</span>
                              <span className="text-[10px] opacity-70">
                                {p.relation}
                                {p.lagMonths ? `+${p.lagMonths}` : ""}
                              </span>
                              <button onClick={() => removePred(a.id, p.id)} className="opacity-50 hover:opacity-100" aria-label="선행 삭제">
                                ×
                              </button>
                            </span>
                          ))}
                          {predAddRow === a.id ? (
                            <span className="inline-flex gap-1 items-center bg-stone-50 border border-stone-300 rounded p-1">
                              <select
                                value={predForm.activityId}
                                onChange={(e) => setPredForm((f) => ({ ...f, activityId: e.target.value }))}
                                className={inputCls}
                                style={{ width: 76 }}
                              >
                                <option value="">활동…</option>
                                {acts
                                  .filter((x) => x.id !== a.id)
                                  .map((x) => (
                                    <option key={x.id} value={x.id}>
                                      {x.id}
                                    </option>
                                  ))}
                              </select>
                              <select
                                value={predForm.relation}
                                onChange={(e) => setPredForm((f) => ({ ...f, relation: e.target.value as Relation }))}
                                className={inputCls}
                                style={{ width: 52 }}
                              >
                                {(["FS", "SS", "FF", "SF"] as Relation[]).map((r) => (
                                  <option key={r}>{r}</option>
                                ))}
                              </select>
                              <input
                                type="number"
                                step="0.5"
                                value={predForm.lagMonths}
                                onChange={(e) => setPredForm((f) => ({ ...f, lagMonths: e.target.value }))}
                                className={inputCls}
                                style={{ width: 48 }}
                                title="Lag(월)"
                              />
                              <button onClick={() => addPred(a.id)} className="px-1.5 py-0.5 rounded bg-sky-700 text-white">
                                추가
                              </button>
                              <button onClick={() => setPredAddRow(null)} className="px-1 text-stone-400">
                                ✕
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => {
                                setPredAddRow(a.id);
                                setPredForm({ activityId: "", relation: "FS", lagMonths: 0 });
                              }}
                              className="w-5 h-5 rounded border border-stone-300 text-stone-500 hover:bg-stone-100 leading-none"
                              aria-label="선행 추가"
                            >
                              ＋
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          value={a.durationMonths}
                          onChange={(e) => patchAct(a.id, { durationMonths: Math.max(0, Number(e.target.value) || 0) })}
                          className={inputCls}
                          style={{ width: 60 }}
                        />
                      </td>
                      {[c?.es, c?.ef, c?.ls, c?.lf].map((v, k) => (
                        <td key={k} className={`px-2 py-1.5 ${monoCls} text-stone-600 bg-stone-50/60`}>
                          {fmtShort(v)}
                        </td>
                      ))}
                      <td
                        className={`px-2 py-1.5 ${monoCls} text-right bg-stone-50/60 ${
                          c?.tf != null && c.tf <= 0 ? "text-red-600 font-bold" : "text-stone-600"
                        }`}
                      >
                        {c?.tf ?? "—"}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {c?.critical ? (
                          <span className="font-bold" style={{ color: "#C0392B" }}>
                            ●
                          </span>
                        ) : (
                          <span className="text-stone-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1">
                          <button onClick={() => dupRow(a.id)} title="복제" className="px-1.5 py-0.5 rounded border border-stone-300 hover:bg-stone-100">
                            ⧉
                          </button>
                          <button onClick={() => delRow(a.id)} title="삭제" className="px-1.5 py-0.5 rounded border border-red-200 text-red-500 hover:bg-red-50">
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* 하단 AI 분석 바 */}
      <div
        className="fixed bottom-0 inset-x-0 z-30 px-5 py-3 flex items-center justify-between gap-3 border-t border-stone-700"
        style={{ background: "#20303F", color: "#F2EFE7" }}
      >
        <div className="text-xs opacity-80 truncate">
          활동 {acts.length}개 · 주공정 {critCount}개 · 완료 예정 <span className="font-mono">{fmtISO(cpm.finishMs)}</span>
        </div>
        <button
          onClick={runAI}
          disabled={ai.loading}
          className="shrink-0 px-5 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 disabled:opacity-60"
          style={{ background: "#E8A33D", color: "#20303F" }}
        >
          {ai.loading ? "분석 중…" : "✦ AI 분석"}
        </button>
      </div>

      {ai.open && (
        <div className="fixed inset-x-0 bottom-16 z-30 px-5">
          <div className="max-w-3xl ml-auto bg-white border border-stone-300 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-4 py-3 flex justify-between items-center border-b border-stone-200" style={{ background: "#F7F5EF" }}>
              <span className="text-sm font-bold">AI 리스크 분석 — 공정·비용</span>
              <button onClick={() => setAi((s) => ({ ...s, open: false }))} className="text-stone-400 hover:text-stone-700">
                ✕
              </button>
            </div>
            <div className="p-4 max-h-[55vh] overflow-y-auto text-sm">
              {ai.loading && (
                <div className="py-8 text-center text-stone-500 text-sm">
                  현재 공정표를 기반으로 지연·비용 리스크를 분석하고 있습니다…
                </div>
              )}
              {ai.error && <div className="text-red-600">{ai.error}</div>}
              {ai.result && (
                <div>
                  {ai.result.summary && <p className="text-stone-700 leading-relaxed mb-4">{ai.result.summary}</p>}
                  <div className="space-y-3">
                    {(ai.result.risks || []).map((r, i) => (
                      <div key={i} className="border border-stone-200 rounded-lg p-3">
                        <div className="flex items-center gap-2 flex-wrap mb-1.5">
                          <span
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                            style={r.category === "비용" ? { background: "#FDF1DC", color: "#8A5A12" } : { background: "#E3EEF6", color: "#215272" }}
                          >
                            {r.category}
                          </span>
                          <span
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                            style={
                              r.severity === "높음"
                                ? { background: "#FCEBEA", color: "#C0392B" }
                                : r.severity === "중간"
                                ? { background: "#FDF6DC", color: "#93700F" }
                                : { background: "#EDF6EC", color: "#3E7A3A" }
                            }
                          >
                            {r.severity}
                          </span>
                          <span className="font-semibold">{r.title}</span>
                          {r.relatedIds && r.relatedIds.length > 0 && (
                            <span className="font-mono text-[10px] text-stone-400">{r.relatedIds.join(", ")}</span>
                          )}
                        </div>
                        <p className="text-xs text-stone-600 leading-relaxed">{r.description}</p>
                        {r.mitigation && (
                          <p className="text-xs mt-1.5 leading-relaxed">
                            <span className="font-bold" style={{ color: "#2F6C93" }}>
                              대응방안
                            </span>{" "}
                            {r.mitigation}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-sm text-white shadow-lg"
          style={{ background: toast.kind === "error" ? "#C0392B" : toast.kind === "warn" ? "#B9770E" : "#20303F" }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
