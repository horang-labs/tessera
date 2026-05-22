# AI 웹툰/코믹 생성 서비스 심층 조사

작성일: 2026-05-19

이 문서는 ComicInk와 유사한 AI 코믹/웹툰 생성 서비스를 조사한 자료다. 공개 웹사이트, 가격표, 도움말, 약관/개인정보처리방침, 앱스토어, 공개 기사만 근거로 사용했다. 비공개 트래픽, 로그인 후 내부 API 추측, 숨겨진 구현 추정은 넣지 않았다.

## 먼저 정정할 점

처음에 "대부분 사짜/허수 서비스"처럼 본 평가는 너무 거칠었다. 특히 ComicInk는 허수 랜딩이 아니다. 공개 자료만 봐도 실제 제품, 가격표, 빠른 생성 플로우, 도움말, 갤러리, iOS 앱, 약관/개인정보처리방침, 외부 AI/인프라 사용 내역이 확인된다.

정확한 판단은 아래에 가깝다.

| 이전 판단 | 수정된 판단 |
|---|---|
| AI 코믹 툴은 대부분 허수다 | 일부는 얇은 SEO/래퍼가 맞지만, ComicInk, Comicory, Comicon, GenToon, AnyKoma, Anifusion, Dashtoon은 실제 제품 깊이가 있다. |
| 캐릭터 일관성은 아직 실사용 어렵다 | 단편/짧은 에피소드 기준으로는 reference image 기반 일관성이 꽤 쓸 만해졌다. 장편/다회차는 별도 벤치마크가 필요하다. |
| 핵심은 자체 모델이다 | 대부분은 자체 파운데이션 모델보다 워크플로우 설계가 핵심이다. 캐릭터 참조, 페이지/패널 상태, 스크립트 분해, 부분 재생성, 말풍선 오버레이, 크레딧 과금이 제품 경쟁력이다. |

## 용어 기준

| 라벨 | 의미 |
|---|---|
| 확인됨 | 공식/공개 소스에 직접 적혀 있거나 화면에서 확인되는 내용 |
| 공개 근거 기반 유추 | 기능 설명, 약관, 가격, 도움말을 종합하면 강하게 추론 가능한 내용 |
| 미확인 | 공개 자료만으로는 확인 불가. 전략의 전제로 삼으면 안 됨 |

## 한 페이지 요약

ComicInk류 제품을 따라 만들 때 지금 가장 현실적인 길은 "자체 이미지 모델부터 학습"이 아니다. 공개된 성공 패턴은 다음이다.

1. 사용자의 스토리/원고를 구조화된 코믹 상태로 바꾼다.
2. 캐릭터 바이블과 reference image를 만든다.
3. 각 페이지/패널 생성 시 캐릭터 reference와 연속성 상태를 같이 넣는다.
4. 대사는 이미지에 굽지 말고 편집 가능한 말풍선 오버레이로 둔다.
5. 패널 단위 재생성, annotation 기반 수정 루프를 제공한다.
6. 페이지/캐릭터/수정/내보내기 단위로 크레딧을 과금한다.
7. 모든 결과와 프롬프트 상태를 `Series -> Issue/Episode -> Page -> Panel` 계층으로 관리한다.

핵심 인사이트:

> 캐릭터 일관성은 "한 번의 좋은 프롬프트" 문제가 아니라, 캐릭터 상태 관리 + reference-conditioned generation + 부분 수정 UX 문제다.

한국 1인/소규모 회사가 MVP로 노릴 우선순위는 아래다.

| 우선순위 | 기능 | 이유 |
|---:|---|---|
| 1 | 원고/프롬프트 -> 패널 스크립트 | 진지한 경쟁 서비스는 이미지 생성 전에 기획/분해 단계가 있다. |
| 2 | 캐릭터 프로필 + reference gallery | 일관성의 핵심이다. |
| 3 | 편집 가능한 말풍선 | 한국어/영어 텍스트를 이미지 모델에 맡기면 품질과 수정성이 떨어진다. |
| 4 | 패널 단위 재생성 | 한 컷이 망가졌다고 전체 에피소드를 다시 만들 수는 없다. |
| 5 | annotation 기반 수정 | ComicInk가 공개적으로 제공하는 고가치 기능이다. |
| 6 | PNG/PDF/웹툰 세로 스트립 export | 창작자 워크플로우에 바로 필요하다. |
| 7 | 크레딧 과금 | 대부분 경쟁사가 credits/pages/images 기반으로 과금한다. |

## 배울 가치 기준 순위

| 순위 | 서비스 | 왜 봐야 하나 |
|---:|---|---|
| 1 | ComicInk | 프롬프트/책/PDF -> 코믹 생성 흐름과 공개 기술 스택이 가장 잘 드러난 사례 |
| 2 | Comicory | 직접 경쟁에 가깝다. 캐릭터 업로드, 전체 코믹 생성, story continuation, 낮은 진입 가격 |
| 3 | Comicon | 캐릭터뿐 아니라 장소/소품까지 asset library로 관리하는 구조가 좋다 |
| 4 | GenToon | 웹툰/숏폼/세로형 출력, 말풍선, 폰트, 모바일 포맷 참고 가치 |
| 5 | AnyKoma | character library, API, credit pricing 모델 참고 |
| 6 | Anifusion | 모델/LoRA/custom model 쪽을 공개적으로 많이 드러내는 창작 suite |
| 7 | Dashtoon | 생성 + 배포 + 수익화까지 묶은 큰 플랫폼 사례 |
| 8 | ComicPad | 유사 제품/가격/속도 메시지 참고 |
| 9 | StoryComic AI | UI/메시징 참고. 다만 신뢰 신호는 더 확인 필요 |
| 10 | YarnSaga | 수동 page editor/graphic novel builder 패턴 참고 |

## 서비스별 조사

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">ComicInk</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 홈페이지 | https://www.comicink.ai/ |
| 가격 | https://www.comicink.ai/pricing |
| 개인정보처리방침 | https://www.comicink.ai/privacy |
| 약관 | https://www.comicink.ai/terms |
| Series/Issue/Page/Panel 도움말 | https://help.comicink.ai/en/article/series-issues-pages-panels-what-each-means-x6xhwd/ |
| Book/PDF -> comic 도움말 | https://help.comicink.ai/en/article/converting-a-book-pdf-into-a-comic-series-tudf6t/ |
| 이미지 오류 수정 도움말 | https://help.comicink.ai/en/article/fixing-image-errors-with-annotations-1fbr1a3/ |
| 갤러리 | https://www.comicink.ai/gallery |
| Quick comic | https://www.comicink.ai/quick |
| App Store | https://apps.apple.com/us/app/comicink/id6760571933 |

## 확인된 제품 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI comic/story generator. Series, Issues, Pages, Panels, 캐릭터 재사용, 갤러리, quick comic flow가 있음 |
| 가격 | credit model. 가격 페이지에서 유료 플랜과 page/cover/character credit 비용 확인 가능 |
| 앱 | iOS 앱 존재. App Store에서 개발자 Sanjoy Ghosh, 버전 히스토리, 평점 확인 가능 |
| 빠른 체험 | Quick Comic 페이지에서 전체 프로젝트 설정 없이 4페이지 코믹 생성 흐름 제공 |
| 프로젝트 구조 | 도움말에서 Series, Issues, Pages, Panels 계층 설명 |
| 원고 변환 | Book/PDF를 comic series로 바꾸는 도움말 존재 |
| 수정 루프 | 이미지 위에 annotation을 하고 오류를 고치는 도움말 존재 |

## 확인된 기술/인프라

ComicInk 개인정보처리방침 기준:

| 레이어 | 확인된 제공자 |
|---|---|
| 스토리 생성 | Google Gemini |
| 이미지 생성 | fal.ai |
| fal.ai 뒤 이미지 모델 예시 | ByteDance Seedream, Google Gemini 등 언급 |
| 안전 필터 | OpenAI moderation API |
| DB/Auth | Supabase |
| 호스팅 | Vercel |
| 결제 | Stripe, Apple In-App Purchase |
| 제품 분석 | PostHog |
| 에러 추적 | Sentry |
| 고객지원 채팅 | Crisp |

약관에도 Gemini, fal.ai, OpenAI 같은 third-party AI service를 사용한다고 적혀 있다.

## 공개 근거 기반 유추: 생성 파이프라인

공식 시스템 다이어그램은 없지만, 개인정보처리방침과 도움말을 종합하면 아래 흐름이 가장 자연스럽다.

```text
사용자 프롬프트 / 업로드한 책 / PDF
-> Gemini가 story, issue/page/panel plan, dialogue, character/world/asset description 생성
-> 앱이 Supabase에 series/issue/page/panel 상태 저장
-> 캐릭터 reference image와 style reference 생성 또는 업로드
-> 각 page/panel 생성 시 prompt + style + character refs + image size를 fal.ai로 전송
-> 생성 전 OpenAI moderation으로 안전성 검사
-> 결과 이미지를 series/issue/page/panel에 연결
-> 대사/캡션은 가능하면 editable overlay로 배치
-> 수정 시 원본 이미지 + annotation overlay + instruction + character refs로 재생성
```

## 캐릭터 일관성 메커니즘

| 메커니즘 | 근거 |
|---|---|
| 캐릭터 프로필 | 제품/도움말에서 series 안의 reusable character 개념 설명 |
| Reference image | 개인정보처리방침에서 character reference images, uploaded reference images가 이미지 생성에 쓰인다고 설명 |
| 패널/페이지 단위 상태 | 도움말이 page/panel 계층과 편집 단위를 설명 |
| Annotation 기반 수정 | 도움말에서 이미지에 표시하고 고치는 흐름 설명 |
| 대사/말풍선 관리 | 제품 페이지와 앱 설명에서 speech bubble, caption, comic page assembly 강조 |

미확인:

| 질문 | 상태 |
|---|---|
| 사용자별 LoRA를 학습하는가 | 미확인 |
| ControlNet/IP-Adapter를 내부적으로 쓰는가 | 미확인 |
| fal.ai에서 어떤 모델을 어떤 작업에 쓰는가 | 미확인. provider와 예시 모델은 나오지만 routing table은 없음 |
| 자체 이미지 모델 weight가 있는가 | 미확인 |

## 따라 만들 포인트

| 기능 | 구현 메모 |
|---|---|
| Series/Issue/Page/Panel 스키마 | 이미지 품질 개선보다 먼저 만들어야 하는 뼈대 |
| 캐릭터 reference gallery | 캐릭터마다 얼굴, 전신, 표정, 의상, optional scene crop 저장 |
| Quick comic mode | 가입 전/복잡한 설정 전 4페이지 생성으로 진입 장벽 낮춤 |
| Book/PDF adapter | IP 보유자에게 중요. 원문을 episode outline/page script로 먼저 변환 |
| Annotation fix | 사용자가 문제 부위를 표시하면 원본+mask/annotation+instruction+refs로 수정 |
| Editable text overlay | 한국어/영어 대사를 이미지 모델에 굽지 않음 |
| Credit accounting | page, cover, character, upscale, fix/regenerate 단위로 비용 추적 |

## 리스크

ComicInk의 공개된 방어력은 자체 모델 IP가 아니라 제품 오케스트레이션이다. 따라서 복제 가능성이 있지만, 동시에 대형 모델사가 기능을 흡수할 위험도 있다. 클론을 만든다면 한국어 웹툰 export, 한국어 말풍선 품질, PD 검수, 웹소설 각색, 팀 리뷰 같은 명확한 wedge가 필요하다.

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">Comicory</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 홈페이지 | https://www.comicory.com/ |
| 캐릭터 업로드 생성기 | https://www.comicory.com/upload-character-comic-generator |
| 가격 | https://www.comicory.com/pricing |
| 약관 | https://www.comicory.com/terms-of-service |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI comic generator. 업로드 캐릭터 reference와 full comic generation 강조 |
| 캐릭터 입력 | 캐릭터 이미지 1-4장을 업로드하고 코믹에 재사용 가능하다고 설명 |
| 스토리 흐름 | story idea를 scripts/pages/panels로 바꾸는 흐름 설명 |
| 이어 만들기 | 첫 생성 이후 story continuation/chapter continuation 설명 |
| 가격 | 공개 가격표 존재 |

## 공개 근거 기반 유추

Comicory는 ComicInk와 비슷한 reference-conditioned generation 구조로 보인다.

```text
스토리 프롬프트
-> script/page plan
-> 업로드/생성된 character references
-> references 기반 panel/page generation
-> continuation/regeneration
```

정확한 이미지 모델/LLM provider는 확인한 공개 페이지에서 드러나지 않았다.

## 따라 만들 포인트

| 기능 | 구현 메모 |
|---|---|
| 캐릭터 이미지 1-4장 업로드 | LoRA 학습 없이도 사용자가 바로 자기 캐릭터를 넣을 수 있음 |
| "같은 캐릭터가 계속 나온다" 메시지 | 사용자의 핵심 pain을 직설적으로 건드림 |
| Continue Story | 웹툰 회차 확장에 중요. 이전 issue summary와 character state 저장 필요 |
| 낮은 진입 가격/무료 script preview | 결제 전 품질 확인 가능하게 하는 구조 |

미확인:

| 질문 | 상태 |
|---|---|
| 이미지 모델 provider | 미확인 |
| LLM provider | 미확인 |
| annotation 기반 local edit 지원 | 공개 페이지 기준 명확하지 않음 |
| 텍스트가 overlay인지 in-image인지 | 명확하지 않음 |

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">Comicon</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 홈페이지 | https://www.comicon.ai/ |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI comic maker. 캐릭터, 장소, 소품, 패널, 말풍선, export 제공 |
| Asset model | characters, locations, props 생성/관리 설명 |
| Editor | comic editor와 layout customization 설명 |
| Export | PNG, JPEG, ZIP, Webtoon format export 언급 |

## 공개 근거 기반 유추

Comicon은 ComicInk보다 asset editor 성격이 강하다.

```text
프로젝트 생성
-> characters / locations / props 생성
-> 선택한 asset과 prompt로 panel 구성
-> panel generation/edit
-> speech bubbles 추가
-> page 또는 webtoon layout export
```

정확한 AI provider는 공개 페이지 기준 미확인이다.

## 따라 만들 포인트

| 기능 | 구현 메모 |
|---|---|
| Asset library | 캐릭터만으로는 부족하다. 장소/소품이 장편 연속성에 중요 |
| Manual editor | 진지한 사용자는 생성 후 직접 수정할 수 있어야 함 |
| Webtoon export | 한국 시장에서는 초기부터 세로 스크롤 export가 필요 |

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">GenToon</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 기능 | https://www.gentoon.ai/en/features |
| AI webtoon page | https://www.gentoon.ai/de/ai-webtoon |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI webtoon/comic generator |
| 포맷 | 9:16, vertical/social format, multi-panel layout 강조 |
| 말풍선 | bubble type과 text tool 설명 |
| 폰트 | 여러 폰트와 웹툰 친화 사용성 언급 |
| creator metrics | 사이트 내 creator/webtoon 수치가 있으나 self-reported marketing metric으로 봐야 함 |

## 판단

GenToon은 책 형태 코믹보다 숏폼/웹툰/소셜 출력에 최적화된 제품으로 보인다. 한국 웹툰 MVP에서는 vertical canvas, bubble template, Korean font control을 참고할 가치가 크다.

미확인:

| 질문 | 상태 |
|---|---|
| 정확한 AI model provider | 미확인 |
| 캐릭터 reference가 구조화된 project state로 저장되는지 | 미확인 |

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">AnyKoma</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 홈페이지 | https://anykoma.com/ |
| 가격 | https://anykoma.com/pricing/ |
| 약관 | https://anykoma.com/terms |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI comic/manga creation platform |
| 캐릭터 라이브러리 | reusable character, character library 강조 |
| 가격 | credit tier와 paid plan 공개 |
| API | API 제공 언급 |
| 회사 | 약관상 JumonAI Inc. |

## 따라 만들 포인트

| 기능 | 구현 메모 |
|---|---|
| Character library 중심 UX | 캐릭터 상태를 prompt history가 아니라 프로젝트 UI의 핵심으로 둬야 함 |
| API는 후순위 | UI 검증 이후에 API 상품화 |
| Credit tier | 이미지 생성 원가와 매출을 맞추기 쉬움 |

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">Anifusion</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 기능 | https://anifusion.ai/all-features/ |
| 가격 | https://anifusion.ai/pricing/ |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | anime/manga/webcomic creation suite |
| 모델 | SDXL/anime-oriented model family, Animagine/Pony/NoobAI 등 모델 계열 공개 |
| LoRA/custom model | LoRA/customization/model training 방향 언급 |
| Editor | panel, text, style, image tool 제공 |
| 가격 | credit/subscription pricing 공개 |

## 왜 중요한가

Anifusion은 "한 프롬프트로 완성 코믹"보다 "모델 제어 가능한 창작 suite"에 가깝다.

```text
Reference images
-> style/model selection
-> optional LoRA/custom model workflow
-> panel/page generation
-> editor/export
```

MVP에는 복잡한 model selector나 LoRA 학습을 바로 넣지 않는 편이 낫다. 다만 power user 기능이나 장기 방어력 측면에서 참고할 가치가 있다.

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">Dashtoon / Dashverse</h1>

공개 소스:

| 항목 | URL |
|---|---|
| Create page | https://www.dashtoon.com/create |
| Dashtoon homepage | https://dashtoon.com/ |
| TechCrunch funding article | https://techcrunch.com/2023/11/02/dashtoon/ |
| Series A article | https://www.moneycontrol.com/news/business/funding/ai-entertainment-startup-dashverse-raises-13-million-funding-led-by-peak-xv-partners-13441053.html |

## 확인된 기능/회사 신호

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI-assisted comic creation and publishing platform |
| 생성 기능 | character consistency, styles, Storyboard2Comic, Live Mode, face fix/upscale 등 언급 |
| 배포 | Dashtoon Reader app과 publish/monetize 흐름 존재 |
| 투자/언론 | TechCrunch seed funding, Series A 기사 등 외부 검증 신호 |

## 판단

Dashtoon은 ComicInk 같은 순수 생성 SaaS보다 더 큰 vertical platform에 가깝다.

```text
creation tooling
-> creator/publisher platform
-> reader app/distribution
-> monetization
```

1인 회사가 처음부터 reader platform까지 만들면 범위가 너무 크다. 먼저 creation workflow를 검증하고, creator retention이 확인된 뒤 publishing/monetization을 붙이는 쪽이 현실적이다.

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">ComicPad</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 홈페이지 | https://www.comicpad.app/ |
| 가격 | https://www.comicpad.app/pricing |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | multi-page comic creation을 내세우는 AI comic generator |
| 가격 | 공개 가격표 존재 |
| Export | PDF 등 export 언급 |

## 판단

ComicInk와 유사한 user promise를 갖지만, 공개 소스 깊이는 ComicInk보다 약하다. 기술 참고보다는 제품 메시지/가격 참고로 보는 편이 맞다.

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">StoryComic AI</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 홈페이지 | https://storycomicai.com/en |
| 가격 | https://storycomicai.com/en/pricing |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI comic/story comic generator |
| Character sheet | character-sheet-style consistency 강조 |
| 가격 | 공개 가격표 존재 |
| 포맷 | social/comic output format 언급 |

## 주의

페이지에 `TechCrunch coming soon` 같은 검증되지 않은 신뢰 신호가 있다. UI/메시징 참고로는 가치가 있지만, 트랙션 증거로 쓰면 안 된다.

<hr />

<h1 style="font-size: 44px; line-height: 1.15; margin: 56px 0 20px; padding-top: 12px; font-weight: 900; letter-spacing: 0; color: #111;">YarnSaga</h1>

공개 소스:

| 항목 | URL |
|---|---|
| 홈페이지 | https://yarnsaga.com/ |

## 확인된 기능

| 영역 | 확인 내용 |
|---|---|
| 제품 | AI story/graphic novel/comic creation tool |
| Editor | page editing, characters, speech/dialogue tools 설명 |
| Publishing | sharing/publishing flow 설명 |

## 판단

YarnSaga는 완전 자동 웹툰 생성기보다 manual creator tool에 가깝다. Page editor와 character-driven setup 패턴 참고 가치가 있다.

## 인접 서비스

| 서비스 | 공개 확인 내용 | 참고 방식 |
|---|---|---|
| Scenario | creative AI infrastructure, custom workflow, LoRA/custom model, API/enterprise positioning | asset consistency와 custom model workflow 참고. 코믹 editor 클론은 아님 |
| Katalist | visual story/storyboard 제품, consistent characters/scenes positioning | script-to-storyboard와 pre-production 참고 |
| REALDRAW | 한국 AI/webtoon 관련 회사 사이트 | 한국 시장/제작사 관점 참고. self-serve SaaS blueprint는 아님 |
| NeuralCanvas | AI comic creation, speech bubbles, e-book export, marketplace/royalty, Vercel/Replicate/AWS 언급 | marketplace/monetization 아이디어 참고 |
| Qomi | panel consistency, storyboard/animation layout, dynamic scene builder 주장 | 제품 깊이 검증 전까지는 UI/feature reference로만 취급 |

## 구현 아키텍처

이 구조는 특정 회사 하나를 베낀 것이 아니라, ComicInk, Comicory, Comicon, GenToon, AnyKoma, Anifusion, Dashtoon에서 공통으로 보이는 패턴을 제품 설계로 정리한 것이다.

## 최소 데이터 모델

| 객체 | 주요 필드 |
|---|---|
| User | id, email, auth_provider, plan, credits_balance |
| Series | id, owner_id, title, genre, style, world_summary, target_format |
| Episode | id, series_id, title, synopsis, continuity_summary, status |
| Page | id, episode_id, page_index, layout_type, image_url, thumbnail_url, status |
| Panel | id, page_id, panel_index, prompt_json, speaker_ids, dialogue_json, image_url, mask_url, status |
| Character | id, series_id, name, role, body, face, hair, outfit, personality, canonical_description |
| CharacterReference | id, character_id, image_url, type, notes, approved |
| Location | id, series_id, name, description, reference_images |
| Prop | id, series_id, name, owner_character_id, description, reference_images |
| GenerationJob | id, user_id, target_type, target_id, provider, model, input_json, output_json, cost_credits, status, error |
| EditAnnotation | id, target_image_id, overlay_url, instruction, mask_url, status |
| Export | id, series_id, episode_id, format, file_url, status |
| CreditLedger | id, user_id, delta, reason, provider_cost_estimate, job_id |

## 생성 흐름

```text
1. 사용자가 quick comic 또는 series를 만든다.
2. LLM이 아이디어/원문을 아래 구조로 분해한다.
   - premise
   - character list
   - episode outline
   - page plan
   - panel plan
   - dialogue
3. 사용자가 캐릭터를 확인/수정한다.
4. 앱이 캐릭터 reference를 생성하거나 업로드받는다.
5. 사용자가 canonical reference를 승인한다.
6. 앱이 page/panel을 생성한다.
   - panel prompt
   - style preset
   - character reference images
   - location/prop references
   - previous continuity summary
7. 앱이 편집 가능한 말풍선을 overlay한다.
8. 사용자가 panel/page regenerate 또는 annotation fix를 실행한다.
9. 앱이 PNG/PDF/webtoon strip으로 export한다.
```

## 내부 프롬프트 payload 예시

긴 문자열 하나로 저장하지 말고, 내부적으로 구조화된 JSON을 유지해야 한다.

```json
{
  "series_style": "vertical Korean webtoon, clean line art, warm lighting",
  "page": {
    "index": 3,
    "layout": "vertical_scroll_3_panels",
    "continuity": "Mina still wears the red school blazer. Her left cheek has a small bandage."
  },
  "panel": {
    "index": 2,
    "shot": "medium close-up",
    "action": "Mina turns away from the window, trying not to cry",
    "emotion": "controlled sadness",
    "location": "classroom at sunset"
  },
  "characters": [
    {
      "id": "mina",
      "name": "Mina",
      "canonical_description": "17-year-old Korean high school student, short black bob, red blazer, small bandage on left cheek",
      "reference_image_ids": ["ref_mina_face", "ref_mina_full_body"]
    }
  ],
  "dialogue": [
    {
      "speaker_id": "mina",
      "text": "I said I'm fine.",
      "bubble_type": "small_round",
      "position_hint": "upper right"
    }
  ]
}
```

## 캐릭터 일관성 구현

MVP에서는 LoRA 학습부터 시작하지 말고, reference 기반 생성으로 먼저 벤치마크한다.

| 단계 | 구현 |
|---|---|
| 캐릭터 생성 | LLM이 사용자 스토리에서 구조화된 character profile 생성 |
| Reference 생성 | 얼굴, 전신, 표정, 의상 2-4장 생성 |
| Reference 업로드 | Comicory처럼 사용자가 1-4장 업로드 가능 |
| Reference 선택 | 해당 캐릭터가 나오는 모든 panel에 approved refs 첨부 |
| Continuity memory | episode별 outfit, injury, carried props, relationship status 저장 |
| Regeneration | 같은 refs와 continuity state로 선택 panel/page만 재생성 |
| Annotation fix | 원본 이미지, annotation/mask, 수정 지시, refs를 image edit provider로 전송 |

## 말풍선/식자

MVP에서 대사를 이미지에 굽지 않는다.

| 레이어 | 추천 |
|---|---|
| 대사 | JSON 텍스트로 생성/편집 |
| 말풍선 렌더링 | HTML/canvas/SVG overlay 또는 server-side renderer |
| 폰트 | 한국어 웹툰용 폰트와 수동 조절 제공 |
| Export | export 시점에만 flatten. 원본은 편집 가능 상태 유지 |
| 화자 매핑 | 각 bubble에 speaker_id 저장 |

이 구조가 한국어 깨짐, 번역/현지화, 수정 요청 문제를 크게 줄인다.

## MVP 빌드 플랜

## MVP 1: ComicInk-Lite

목표: 짧은 코믹을 캐릭터 reference 기반으로 안정 생성.

| 모듈 | 요구사항 |
|---|---|
| Auth/Billing | Supabase auth, Stripe, simple credit ledger |
| Project schema | Series, Episode, Page, Panel, Character, ReferenceImage |
| Story planner | prompt/source text -> 4-12 panel script |
| Character refs | 캐릭터별 1-4장 생성 또는 업로드 |
| Panel generator | panel JSON + refs로 한 컷씩 생성 |
| Page composer | vertical strip 또는 page grid 배치 |
| Dialogue overlay | 편집 가능한 말풍선 |
| Regenerate | 같은 refs로 panel 재생성 |
| Export | PNG/PDF/vertical webtoon strip |

## MVP 2: 제작자 워크플로우

| 모듈 | 요구사항 |
|---|---|
| Book/PDF adapter | 업로드한 장/챕터를 episode/page outline으로 변환 |
| Continuity tracker | episode 종료 시 캐릭터/장소/소품 상태 자동 요약 |
| Annotation fix | 문제 영역을 표시하고 edit job 실행 |
| Multi-character scene | panel별 speaker/character placement metadata |
| Location/prop refs | 재사용 가능한 장소/소품 reference 저장 |

## MVP 3: 한국 시장 차별화

| 모듈 | 요구사항 |
|---|---|
| Korean lettering | 한국어 말풍선 폰트, vertical scroll rhythm, 효과음 배치 |
| Web novel adaptation | 웹소설 챕터 -> 웹툰 콘티/패널 스크립트 압축 |
| PD review mode | 댓글, 수정 요청, 버전 비교 |
| Layered export | 최소 image + text JSON + bubble layout. 가능하면 PSD/CSP 유사 export |
| IP safety logs | prompt, refs, model/provider, timestamp, edit history 저장 |

## Provider 선택

이건 경쟁사가 모두 이렇게 쓴다는 뜻이 아니라, 공개 근거와 현재 현실성을 반영한 MVP 선택지다.

| 레이어 | 보수적 선택 | 이유 |
|---|---|---|
| Frontend | Next.js | Vercel/Supabase와 궁합 좋고 빠른 MVP 가능 |
| DB/Auth/Storage | Supabase | ComicInk도 Supabase 사용 확인. 프로젝트 상태/스토리지/크레딧 ledger에 충분 |
| LLM planner | Gemini 또는 OpenAI/Claude | ComicInk는 Gemini 사용 확인. 구조화 출력 가능한 강한 LLM이면 됨 |
| Image generation | fal.ai-hosted models, GPT Image, Gemini image, Seedream, FLUX Pro/Kontext Pro | ComicInk는 fal.ai 사용 확인. MVP는 GPU 운영보다 hosted API가 맞음 |
| Moderation | OpenAI moderation 또는 provider-native safety | ComicInk는 OpenAI moderation 사용 확인 |
| Payments | Stripe + 모바일이면 Apple IAP | ComicInk는 Stripe와 Apple IAP 확인 |
| Analytics/Error | PostHog + Sentry | ComicInk도 둘 다 사용 확인 |

중요: 2026년 기준으로 SDXL을 메인 출력 엔진으로 두면 품질 경쟁에서 불리하다. 최신 상용/호스팅 이미지 모델을 메인 렌더링으로 쓰고, open-weight/LoRA 계열은 고급 제어력이나 비용 최적화, custom character 실험용으로 두는 편이 맞다.

## 벤치마크

이 테스트를 통과하기 전에는 custom model 학습이나 대형 플랫폼 확장에 들어가지 않는 편이 낫다.

| 테스트 | 입력 | 통과 기준 |
|---|---|---|
| 4컷 quick comic | 캐릭터 1명, 장소 1개, 감정 변화 1개 | 4컷 모두 같은 캐릭터로 인식, 대사 화자 오류 없음, 손/얼굴 치명 오류 1컷 이하 |
| 12컷 episode | 주인공 2명, 소품 1개, 장소 2개 | 캐릭터/의상/소품 일관성 80% 이상 |
| 30컷 webtoon | 캐릭터 3명, 교실/카페/집 재등장 | 캐릭터 swap 없음, 의상 drift 적음, 장소 재인식 가능 |
| 수정 루프 | local fix 10개 | 7/10 이상에서 수정 부위 외 영역 유지 |
| 한국어 대사 | 말풍선 20개 | 최종 export에서 텍스트가 편집 가능하고 깨짐 없음 |

## 경쟁사에서 배울 점

| 교훈 | 근거 |
|---|---|
| 짧은 코믹은 reference image만으로도 꽤 된다 | ComicInk, Comicory, AnyKoma, GenToon 모두 character reuse/reference consistency를 전면에 둔다 |
| Editor가 generator만큼 중요하다 | ComicInk fix docs, Comicon editor, YarnSaga editor, Anifusion suite |
| 웹툰/모바일 포맷이 중요하다 | GenToon, Dashtoon이 vertical/social consumption을 강조 |
| Credit 과금이 기본이다 | ComicInk, Comicory, AnyKoma, Anifusion, ComicPad 가격표 |
| 정확한 모델 IP는 대부분 공개하지 않는다 | ComicInk 정도가 provider level을 비교적 투명하게 밝힘 |
| 학습은 MVP 후순위다 | reference workflow로 먼저 검증하고, 실패하는 지점에만 custom model/LoRA를 붙인다 |

## 피해야 할 레드플래그

| 레드플래그 | 문제 |
|---|---|
| "100화 완벽 일관성" 같은 과장 | 약관들은 보통 AI 결과의 품질/재현성/일관성을 보장하지 않는다 |
| 대사를 이미지에 굽기 | 한국어 품질, 수정, 번역, export 모두 나빠짐 |
| 프로젝트 계층 부재 | 장편에는 series/episode/page/panel 상태가 필수 |
| 승인된 캐릭터 reference 부재 | prompt-only memory는 drift가 심하다 |
| 패널 단위 재생성 부재 | 한 컷 문제로 전체를 다시 만들면 사용자가 이탈 |
| 생성 로그 부재 | IP 보유자는 어떤 모델/프롬프트/reference가 결과를 만들었는지 알아야 한다 |

## 실제 클론 스펙

처음 버전은 아래 화면 정도면 된다.

| 화면 | 기능 |
|---|---|
| Quick Comic | prompt, style, protagonist, 4-page output, 최소 설정 |
| Series Dashboard | episodes, characters, locations, props, exports |
| Character Studio | refs 생성/업로드, canonical look 승인, outfit variants |
| Script Planner | chapter/prompt -> pages/panels, 렌더링 전 수정 가능 |
| Page Editor | panel images, bubble overlay, regenerate panel, fix annotation |
| Export | PNG, PDF, vertical strip, JSON source bundle |
| Billing | credits, job history, failed job refund |

최소 기술 요구사항:

| 컴포넌트 | 요구사항 |
|---|---|
| LLM output | characters/pages/panels/dialogue strict JSON schema |
| Image job queue | async jobs, retry, provider/model 기록 |
| Reference handling | approved refs 저장, 생성 요청마다 첨부 |
| Bubble renderer | editable DOM/canvas overlay, export 시 flatten |
| Annotation editor | overlay/mask와 fix instruction 저장 |
| Cost tracking | generation/edit/upscale/export마다 credit ledger 기록 |

## 최종 판단

ComicInk와 유사 제품들은 배울 가치가 충분하다. 기회는 "이미지 생성기"를 만드는 데 있지 않고, 이미지 모델 위에 안정적인 코믹 제작 워크플로우를 얹는 데 있다.

가장 복제 가능한 승리 패턴:

```text
structured story planning
+ character reference state
+ panel/page hierarchy
+ editable lettering
+ local regeneration/fix loop
+ vertical webtoon export
+ credit billing
```

한국 창업자에게 가장 가능성 높은 wedge는 범용 글로벌 AI comic generator가 아니다. 한국어 웹소설 -> 웹툰 각색, 한국어 말풍선/식자, PD 검수, 세로 스크롤 연출, 제작 검수용 export를 잘 묶는 제품이다.

## 출처 모음

| 서비스 | 공개 소스 |
|---|---|
| ComicInk | https://www.comicink.ai/, https://www.comicink.ai/pricing, https://www.comicink.ai/privacy, https://www.comicink.ai/terms, https://help.comicink.ai/en/article/series-issues-pages-panels-what-each-means-x6xhwd/, https://help.comicink.ai/en/article/converting-a-book-pdf-into-a-comic-series-tudf6t/, https://help.comicink.ai/en/article/fixing-image-errors-with-annotations-1fbr1a3/, https://www.comicink.ai/gallery, https://www.comicink.ai/quick, https://apps.apple.com/us/app/comicink/id6760571933 |
| Comicory | https://www.comicory.com/, https://www.comicory.com/upload-character-comic-generator, https://www.comicory.com/pricing, https://www.comicory.com/terms-of-service |
| Comicon | https://www.comicon.ai/ |
| GenToon | https://www.gentoon.ai/en/features, https://www.gentoon.ai/de/ai-webtoon |
| AnyKoma | https://anykoma.com/, https://anykoma.com/pricing/, https://anykoma.com/terms |
| Anifusion | https://anifusion.ai/all-features/, https://anifusion.ai/pricing/ |
| Dashtoon/Dashverse | https://www.dashtoon.com/create, https://dashtoon.com/, https://techcrunch.com/2023/11/02/dashtoon/, https://www.moneycontrol.com/news/business/funding/ai-entertainment-startup-dashverse-raises-13-million-funding-led-by-peak-xv-partners-13441053.html |
| ComicPad | https://www.comicpad.app/, https://www.comicpad.app/pricing |
| StoryComic AI | https://storycomicai.com/en, https://storycomicai.com/en/pricing |
| YarnSaga | https://yarnsaga.com/ |
| Scenario | https://www.scenario.com/ |
| Katalist | https://www.katalist.ai/storytelling |
| REALDRAW | https://www.realdraw.ai/en |
| NeuralCanvas | https://www.neuralcanvas.io/ |
| Qomi | https://qomi.art/ |
