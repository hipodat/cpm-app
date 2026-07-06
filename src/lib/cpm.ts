/* ============================================================
   CPM 계산 엔진 (순수 함수)
   - 그래프(DAG) + 위상정렬 + forward/backward pass
   ============================================================ */

export type Relation = "FS" | "SS" | "FF" | "SF";

export interface Predecessor {
  id: string;
  activityId: string;
  relation: Relation;
  lagMonths: number;
}

export interface Activity {
  id: string;
  wbs: string;
  name: string;
  owner: string; // 담당부서
  predecessors: Predecessor[];
  durationMonths: number;
}

export interface Computed {
  es: number | null;
  ef: number | null;
  ls: number | null;
  lf: number | null;
  tf: number | null;
  critical: boolean;
  error: string | null;
}

export interface CpmResult {
  byId: Map<string, Computed>;
  finishMs: number;
  cycleIds: string[];
  validPreds: Map<string, Predecessor[]>;
}

/* ---------------- 날짜 유틸 (UTC 일 단위) ---------------- */
export const DAY = 86400000;
export const pad2 = (n: number) => String(n).padStart(2, "0");
export const parseISO = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const fmtISO = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
export const fmtShort = (t: number | null | undefined) => {
  if (t == null) return "—";
  const d = new Date(t);
  return `${String(d.getUTCFullYear()).slice(2)}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())}`;
};
export const addDays = (t: number, n: number) => t + Math.round(n) * DAY;

// 정수부: 실제 달력월 이동(말일 보정), 소수부: 1개월≈30일 근사, 음수 지원
export const addCalMonths = (t: number, m: number) => {
  const d = new Date(t);
  const y = d.getUTCFullYear(),
    mo = d.getUTCMonth(),
    day = d.getUTCDate();
  const ty = y + Math.floor((mo + m) / 12);
  const tm = (((mo + m) % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return Date.UTC(ty, tm, Math.min(day, last));
};
export const addMonthsF = (t: number, months: number) => {
  const i = Math.trunc(months);
  const f = months - i;
  return addDays(addCalMonths(t, i), Math.round(f * 30));
};
export const startOfMonth = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const todayUTC = () => {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
};
export const fmtDur = (d: number) => Number((d || 0).toFixed(2));

/* ---------------- 관계유형별 계산 ---------------- */
function candidateES(
  predComp: { es: number; ef: number },
  edge: Predecessor,
  succDur: number
): number {
  const lag = edge.lagMonths || 0;
  switch (edge.relation) {
    case "FS":
      return addDays(addMonthsF(predComp.ef, lag), 1);
    case "SS":
      return addMonthsF(predComp.es, lag);
    case "FF": {
      const efC = addMonthsF(predComp.ef, lag);
      return succDur > 0 ? addMonthsF(addDays(efC, 1), -succDur) : efC;
    }
    case "SF": {
      const efC = addMonthsF(predComp.es, lag);
      return succDur > 0 ? addMonthsF(addDays(efC, 1), -succDur) : efC;
    }
    default:
      return addDays(addMonthsF(predComp.ef, lag), 1);
  }
}
function candidateLF(
  succBack: { ls: number; lf: number },
  edge: Predecessor,
  predDur: number
): number {
  const lag = edge.lagMonths || 0;
  const lsToLf = (ls: number) => (predDur > 0 ? addDays(addMonthsF(ls, predDur), -1) : ls);
  switch (edge.relation) {
    case "FS":
      return addMonthsF(addDays(succBack.ls, -1), -lag);
    case "SS":
      return lsToLf(addMonthsF(succBack.ls, -lag));
    case "FF":
      return addMonthsF(succBack.lf, -lag);
    case "SF":
      return lsToLf(addMonthsF(succBack.lf, -lag));
    default:
      return addMonthsF(addDays(succBack.ls, -1), -lag);
  }
}

/* ---------------- 메인 계산 (순수 함수) ---------------- */
export function computeCPM(activities: Activity[], projectStartMs: number): CpmResult {
  const byAct = new Map<string, Activity>();
  const dup = new Set<string>();
  activities.forEach((a) => {
    if (byAct.has(a.id)) dup.add(a.id);
    byAct.set(a.id, a);
  });

  const errors = new Map<string, string>();
  dup.forEach((id) => errors.set(id, "ID가 중복되었습니다"));

  const validPreds = new Map<string, Predecessor[]>();
  const succEdges = new Map<string, { succId: string; edge: Predecessor }[]>(
    activities.map((a) => [a.id, []])
  );
  for (const a of activities) {
    const vp: Predecessor[] = [];
    for (const p of a.predecessors || []) {
      if (p.activityId === a.id) errors.set(a.id, "자기 자신을 선행으로 참조합니다");
      else if (!byAct.has(p.activityId)) errors.set(a.id, `존재하지 않는 선행 ID: ${p.activityId}`);
      else vp.push(p);
    }
    validPreds.set(a.id, vp);
  }
  for (const a of activities)
    for (const p of validPreds.get(a.id)!)
      succEdges.get(p.activityId)!.push({ succId: a.id, edge: p });

  // 위상정렬 (Kahn)
  const indeg = new Map<string, number>(activities.map((a) => [a.id, validPreds.get(a.id)!.length]));
  const queue = activities.filter((a) => indeg.get(a.id) === 0).map((a) => a.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const { succId } of succEdges.get(id)!) {
      indeg.set(succId, indeg.get(succId)! - 1);
      if (indeg.get(succId) === 0) queue.push(succId);
    }
  }
  const orderSet = new Set(order);
  const cycleIds = activities.filter((a) => !orderSet.has(a.id)).map((a) => a.id);
  cycleIds.forEach((id) => errors.set(id, `순환참조가 감지되었습니다 (관련: ${cycleIds.join(", ")})`));

  // Forward pass
  const comp = new Map<string, { es: number; ef: number }>();
  for (const id of order) {
    const a = byAct.get(id)!;
    const dur = a.durationMonths || 0;
    let es: number | null = null;
    for (const p of validPreds.get(id)!) {
      const pc = comp.get(p.activityId);
      if (!pc) continue;
      const cand = candidateES(pc, p, dur);
      es = es == null ? cand : Math.max(es, cand);
    }
    if (es == null) es = projectStartMs;
    const ef = dur > 0 ? addDays(addMonthsF(es, dur), -1) : es;
    comp.set(id, { es, ef });
  }

  // 프로젝트 완료일 = 오류 없는 유효 활동들의 EF 최댓값 (에러 전파 방지)
  let finishMs = projectStartMs;
  for (const id of order) {
    if (errors.has(id)) continue;
    const c = comp.get(id);
    if (c && c.ef > finishMs) finishMs = c.ef;
  }

  // Backward pass
  const back = new Map<string, { ls: number; lf: number }>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const a = byAct.get(id)!;
    const dur = a.durationMonths || 0;
    let lf: number | null = null;
    for (const { edge, succId } of succEdges.get(id)!) {
      const sb = back.get(succId);
      if (!sb) continue;
      const cand = candidateLF(sb, edge, dur);
      lf = lf == null ? cand : Math.min(lf, cand);
    }
    if (lf == null) lf = finishMs;
    const ls = dur > 0 ? addMonthsF(addDays(lf, 1), -dur) : lf;
    back.set(id, { ls, lf });
  }

  const byId = new Map<string, Computed>();
  for (const a of activities) {
    const c = comp.get(a.id);
    const b = back.get(a.id);
    const error = errors.get(a.id) || null;
    if (!c) {
      byId.set(a.id, { es: null, ef: null, ls: null, lf: null, tf: null, critical: false, error });
    } else {
      const tf = b ? Math.round((b.lf - c.ef) / DAY) : null;
      byId.set(a.id, {
        es: c.es,
        ef: c.ef,
        ls: b ? b.ls : null,
        lf: b ? b.lf : null,
        tf,
        critical: !error && tf != null && tf <= 0,
        error,
      });
    }
  }
  return { byId, finishMs, cycleIds, validPreds };
}

export function wouldCreateCycle(activities: Activity[], predId: string, succId: string): boolean {
  if (predId === succId) return true;
  const ids = new Set(activities.map((a) => a.id));
  const succMap = new Map<string, string[]>(activities.map((a) => [a.id, []]));
  for (const a of activities)
    for (const p of a.predecessors || [])
      if (ids.has(p.activityId) && p.activityId !== a.id) succMap.get(p.activityId)!.push(a.id);
  const stack = [succId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === predId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nx of succMap.get(cur) || []) stack.push(nx);
  }
  return false;
}

export function relationFromPorts(fromSide: "start" | "finish", toSide: "start" | "finish"): Relation {
  if (fromSide === "finish" && toSide === "start") return "FS";
  if (fromSide === "start" && toSide === "start") return "SS";
  if (fromSide === "finish" && toSide === "finish") return "FF";
  return "SF";
}

export type MovePlan =
  | { type: "noop" }
  | { type: "snap"; snapTo: number }
  | { type: "moveProject"; newProjectStart: number }
  | { type: "lag"; activities: Activity[]; newLag: number; edgeId: string };

export function planMove(
  activities: Activity[],
  projectStartMs: number,
  id: string,
  targetStartMs: number
): MovePlan {
  const res = computeCPM(activities, projectStartMs);
  const act = activities.find((a) => a.id === id);
  if (!act) return { type: "noop" };
  const vp = res.validPreds.get(id) || [];
  if (vp.length === 0) return { type: "moveProject", newProjectStart: targetStartMs };
  const c = res.byId.get(id);
  if (!c || c.es == null) return { type: "noop" };
  if (targetStartMs < c.es) return { type: "snap", snapTo: c.es };
  if (targetStartMs === c.es) return { type: "noop" };
  let best: Predecessor | null = null;
  let bestVal = -Infinity;
  for (const p of vp) {
    const pc = res.byId.get(p.activityId);
    if (!pc || pc.es == null || pc.ef == null) continue;
    const v = candidateES({ es: pc.es, ef: pc.ef }, p, act.durationMonths || 0);
    if (v > bestVal) {
      bestVal = v;
      best = p;
    }
  }
  if (!best) return { type: "noop" };
  let lag = best.lagMonths || 0;
  let acts = activities;
  for (let i = 0; i < 4; i++) {
    const cur = computeCPM(acts, projectStartMs).byId.get(id)!;
    const residual = (targetStartMs - (cur.es as number)) / DAY;
    if (Math.abs(residual) < 0.5) break;
    lag = Math.round((lag + residual / 30) * 1000) / 1000;
    acts = acts.map((a) =>
      a.id !== id
        ? a
        : {
            ...a,
            predecessors: a.predecessors.map((p) =>
              p.id === best!.id ? { ...p, lagMonths: lag } : p
            ),
          }
    );
  }
  return { type: "lag", activities: acts, newLag: lag, edgeId: best.id };
}

export function durationForRange(startMs: number, targetEndMs: number): number {
  const days = Math.max(0, (targetEndMs - startMs) / DAY + 1);
  let dur = Math.round((days / 30) * 100) / 100;
  if (dur > 0) {
    const ef = addDays(addMonthsF(startMs, dur), -1);
    const residual = (targetEndMs - ef) / DAY;
    dur = Math.max(0, Math.round((dur + residual / 30) * 1000) / 1000);
  }
  return dur;
}

/* ---------------- 시드 데이터 ---------------- */
let _eid = 0;
export const eid = () => `e${++_eid}_${Math.random().toString(36).slice(2, 7)}`;
const P = (activityId: string, relation: Relation = "FS", lagMonths = 0): Predecessor => ({
  id: eid(),
  activityId,
  relation,
  lagMonths,
});
export const seedActivities = (): Activity[] => [
  { id: "A010", wbs: "인허가", name: "실시계획승인", owner: "", predecessors: [], durationMonths: 3 },
  { id: "A020", wbs: "보상", name: "토지보상", owner: "", predecessors: [P("A010")], durationMonths: 6 },
  { id: "A030", wbs: "토목", name: "부지조성공사", owner: "", predecessors: [P("A020")], durationMonths: 8 },
  { id: "A040", wbs: "전기", name: "전력구설치", owner: "", predecessors: [P("A030", "SS", 2)], durationMonths: 6 },
  { id: "A050", wbs: "설비", name: "공업용수 관로건설", owner: "", predecessors: [P("A030", "SS", 3)], durationMonths: 5 },
  { id: "A060", wbs: "전기", name: "변전소 건설", owner: "", predecessors: [P("A040")], durationMonths: 5 },
  { id: "A070", wbs: "토목", name: "진입도로 및 단지내도로", owner: "", predecessors: [P("A030", "SS", 4)], durationMonths: 6 },
  { id: "A080", wbs: "환경", name: "오폐수처리시설", owner: "", predecessors: [P("A030")], durationMonths: 4 },
  { id: "A090", wbs: "건축", name: "공장 건축공사", owner: "", predecessors: [P("A070"), P("A050"), P("A060")], durationMonths: 10 },
  { id: "A100", wbs: "준공", name: "시운전 및 준공검사", owner: "", predecessors: [P("A090"), P("A060", "FF", 0)], durationMonths: 2 },
];
export const seedProject = () => ({ startDate: "2026-07-01", activities: seedActivities() });
