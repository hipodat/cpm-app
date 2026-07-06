# 건설공정관리 (CPM)

산업단지·공장 건설 기획단계용 CPM(Critical Path Method) 공정관리 웹앱입니다.
활동과 선후행 관계를 입력하면 ES/EF/LS/LF·총여유·주공정을 자동 계산하고,
인터랙티브 간트차트(드래그 리스케줄링·마우스 선후행 연결)로 시각화하며,
엑셀 내보내기와 AI 리스크 분석(공정·비용)을 제공합니다.

## 주요 기능

- **CPM 계산 엔진**: 그래프(DAG) + 위상정렬 기반 forward/backward pass. FS/SS/FF/SF 관계, 소수 개월/Lag, 말일 보정, 순환참조·오류 격리
- **간트 + 일정표 동시 표시**: 한쪽을 수정하면 다른 쪽 즉시 동기화
- **드래그**: 막대 이동(ES 스냅 / Lag 반영), 끝단 리사이즈, 막대 더블클릭으로 기간 직접 입력
- **마우스 연결**: 커넥터 위치로 FS/SS/FF/SF 자동 결정, 순환 시 연결 차단, 연결선 클릭 수정·삭제
- **엑셀 내보내기**: 시트1 일정입력, 시트2 간트차트
- **AI 분석**: 서버 API 라우트에서 Groq API(Llama 3.1 70B) 호출(키는 서버에만 보관). 공정 지연·비용 리스크와 대응방안 제안

## 로컬 실행

```bash
npm install
cp .env.example .env.local   # 그리고 .env.local 안의 GROQ_API_KEY 값을 본인 키로 채우기
npm run dev
```

http://localhost:3000 접속.

## Vercel 배포

1. 이 폴더를 GitHub 저장소에 올립니다.
   ```bash
   git init && git add . && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<본인>/<저장소>.git
   git push -u origin main
   ```
2. https://vercel.com 에서 **Add New → Project → Import**로 해당 저장소를 선택합니다.
3. **Environment Variables**에 아래 항목을 추가합니다.
   - `GROQ_API_KEY` = 본인 Groq API 키 (https://console.groq.com/keys 에서 발급)
4. **Deploy**를 누릅니다.

> CLI로 배포하려면 폴더에서 `npx vercel` 실행 후 안내에 따라 로그인·설정하고,
> `npx vercel env add GROQ_API_KEY` 로 키를 등록한 뒤 `npx vercel --prod` 로 배포합니다.

### API 키 관련 주의

- 키는 서버 환경변수(`process.env.GROQ_API_KEY`)로만 사용되며, `src/app/api/analyze/route.ts` 서버 라우트에서만 읽습니다. **브라우저에는 절대 노출되지 않습니다.**
- 키가 없으면 앱은 정상 동작하되 "AI 분석" 버튼만 오류 메시지를 표시합니다.

## 데이터 저장

현재는 브라우저 `localStorage`에 저장됩니다(`src/lib/storage.ts`).
서버 저장(예: Supabase)으로 확장하려면 이 파일의 `loadProject`/`saveProject` 구현만 교체하면 됩니다.

## 폴더 구조

```
src/
  app/
    api/analyze/route.ts   # AI 분석 서버 라우트 (API 키 사용)
    layout.tsx, page.tsx, globals.css
  components/
    Scheduler.tsx          # 메인 UI (간트·테이블·엑셀·AI)
  lib/
    cpm.ts                 # CPM 계산 엔진(순수 함수) + 타입 + 시드
    storage.ts             # 데이터 접근 계층
```

## 모델 표기

AI 분석은 Groq의 `llama-3.1-70b-versatile` 모델을 사용합니다. 다른 모델로 바꾸려면
`src/app/api/analyze/route.ts` 의 `model` 값을 수정하세요.
