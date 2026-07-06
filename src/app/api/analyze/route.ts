import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface AnalyzeBody {
  startDate: string;
  finishDate: string;
  totalMonths: string;
  activityCount: number;
  criticalCount: number;
  criticalPath: string;
  today: string;
  rows: string;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "서버에 GROQ_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요." },
      { status: 500 }
    );
  }

  let body: AnalyzeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const prompt = `당신은 산업단지·공장 건설사업의 공정관리(CPM) 및 사업비 리스크 분석 전문가입니다.
아래는 기획단계 CPM 공정표 데이터입니다. **공정 지연 리스크**와 **비용(사업비 증가) 리스크**를 중심으로 분석하고, 각 리스크에 대한 실행 가능한 해결방안을 제시하세요.

[프로젝트 개요]
- 시작일: ${body.startDate} / 예상 완료일: ${body.finishDate} / 총공기: 약 ${body.totalMonths}개월
- 활동 수: ${body.activityCount}개 / 주공정 활동: ${body.criticalCount}개
- 주공정 경로: ${body.criticalPath || "(계산 불가)"}
- 오늘 날짜: ${body.today}

[활동 목록]
${body.rows}

분석 관점(반드시 반영):
1) 주공정 활동의 지연 파급효과, 여유(Float)가 적은 활동, 병렬공정의 병목
2) 인허가·토지보상 등 대관업무의 일정 불확실성
3) 공기 지연이 초래하는 비용 증가(간접비, 금융비용, 물가상승/에스컬레이션, 지체상금)
4) SS/FF 등 중첩 관계와 Lag에 내재된 리스크

중요: 모든 텍스트는 **한글(순수 한국어)**로만 작성하세요. 한자나 다른 언어를 절대 섞지 마세요.

반드시 아래 JSON 형식으로만 응답하세요. 마크다운 코드블록이나 다른 텍스트를 포함하지 마세요:
{"summary":"전체 총평 2~3문장","risks":[{"category":"공정" 또는 "비용","severity":"높음"/"중간"/"낮음","title":"리스크 제목","description":"리스크 설명 1~2문장","mitigation":"해결방안 1~2문장","relatedIds":["관련 활동ID"]}]}
risks는 중요도 순으로 최대 5개.`;

  const url = "https://api.groq.com/openai/v1/chat/completions";
  const model = "llama-3.3-70b-versatile";

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1500,
        }),
      });

      if (res.status === 429) {
        lastErr = "429";
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        return NextResponse.json(
          { error: `Groq API 오류 (${res.status})`, detail: errText.slice(0, 500) },
          { status: 502 }
        );
      }

      const data = await res.json();
      const text: string = data?.choices?.[0]?.message?.content ?? "";

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch {
        /* 파싱 실패 → 원문 반환 */
      }

      if (parsed && typeof parsed === "object" && "risks" in parsed) {
        return NextResponse.json(parsed);
      }
      return NextResponse.json({ summary: text, risks: [] });
    } catch {
      lastErr = "network";
    }
  }
  const msg =
    lastErr === "429"
      ? "Groq API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요."
      : "AI 분석 요청에 실패했습니다. 잠시 후 다시 시도하세요.";
  return NextResponse.json({ error: msg }, { status: 502 });
}
