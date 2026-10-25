# Gato's Visual Novel — 기획서

- 모듈 id: `gatos-visual-novel` / 제목: **Gato's Visual Novel** / 폴더: `modules/gatos-visual-novel`
- 필수 의존: `gatos-chat-tools` (v0.2.0 이상 — §9의 확장 지점이 추가된 버전)
- 호환: Foundry VTT **v13 (13.351 기준 개발) · v14 (14.359+ 안정판)** — `compatibility: { minimum: "13", verified: "14" }`
- 시스템 무관. jQuery·AppV1 사용 금지, `foundry.applications.*` 네임스페이스만 사용.
- 구현 담당: Claude Opus 5.5. 이 문서는 구현 사양서이며, 각 §의 "구현 메모"가 코드 수준 결정을 담는다.
- 작성일: 2026-10-21

---

## 0. 용어

| 용어 | 뜻 |
|---|---|
| **채팅창** | Foundry 오른쪽 사이드바(`#sidebar`, 채팅 탭 포함) |
| **노벨창(스테이지)** | 사이드바와 Taskbar(핫바 `#ui-bottom`)를 제외한 캔버스 위 영역에 띄우는 비주얼 노벨 오버레이 |
| **표정(face)** | 얼굴만 나오는 정사각형 계열 포트레잇. 채팅 카드 왼쪽 포트레잇으로 쓴다 |
| **스탠딩(stand)** | 세로형(어깨/반신/전신) 일러스트. 노벨창에 세운다 |
| **표정 항목(expression entry)** | 이름 + face 이미지 + stand 이미지 한 묶음. 액터마다 여러 개 |
| **기본 항목** | 모든 액터가 반드시 가지는 표정 항목(id `default`). 삭제 불가, 이미지는 비울 수 있음 |
| **대사창(dialogue box)** | 노벨창 하단의 이름표 + 본문 박스 |
| **참조 이미지(ref)** | 키워드 링크가 걸린 메시지에서 노벨창 중앙에 띄우는 문서(저널/아이템/액터) 이미지·텍스트 패널 |
| **로그 플레이어** | 아카이브(JSON) 또는 내보낸 폴더(HTML)를 노벨창 형태로 재생하는 기능. **이번 범위 밖**, 데이터 형식만 준비 |

---

## 1. 요구사항 요약 (사용자 원문 → 사양)

1. 액터마다 표정/스탠딩 쌍을 여러 개 지정. `기본` 항목은 액터 이미지를 초깃값으로 쓰고 삭제 불가(이미지 비우기는 가능).
2. 채팅 카드 포트레잇은 **메시지 생성 시 선택된 표정**이 최우선. 노벨창에는 그 표정의 스탠딩이 비주얼 노벨처럼 표시.
3. 말한 액터의 대사가 노벨창 대사창에 표시. 동시에 세우는 스탠딩은 최대 6개. 말한 캐릭터만 컬러, 나머지는 회색.
4. face만 있거나 stand만 있는 항목도 허용. 대체 순서:
   - 채팅 카드(face): 지정 face → **지정 stand → 기본 face → 토큰 → 액터 이미지**
   - 노벨창(stand): 지정 stand → **지정 face → 기본 stand → 토큰 → 액터 이미지**
5. 노벨창은 사용자가 채팅 메뉴에서 끌 수 있고, GM은 전원을 한 번에 켜고 끌 수 있다.
6. GM 또는 대상 문서(저널/아이템/액터)에 **관찰자 이상** 권한이 있는 플레이어는 **키워드**로 링크를 걸 수 있다. 클릭하면 관찰자 이상인 사용자에게 해당 문서 창이 열린다. 링크가 걸린 메시지에 한해 노벨창 중앙에 그 문서의 이미지를 참조 이미지로 띄운다.
7. 폴더/zip 내보내기 시 링크된 저널/아이템/액터의 이미지·텍스트를 담은 **서브 HTML**이 함께 나가고, 링크 클릭 시 새 창으로 열린다.
8. 아카이브 JSON에 카드 이미지·이름·플레이어·생성일시와 함께 **생성 시점의 표정**을 기록.
9. 로그 플레이어(월드 안에서 JSON, 로컬에서 폴더 HTML)를 나중에 만들 수 있도록 데이터·코드 구조를 준비.

---

## 2. 전체 구조

```
modules/gatos-visual-novel/
├─ module.json
├─ PLAN.md                      ← 이 문서
├─ README.md                    ← 구현 완료 후 사용자 설명서 (chat-tools README 형식)
├─ lang/ko.json, lang/en.json   ← i18n 네임스페이스 "GVN"
├─ styles/visual-novel.css
├─ templates/
│  ├─ expression-config.hbs     ← 액터 표정 편집기
│  ├─ expression-picker.hbs     ← 발화자 바 표정 선택 스트립
│  ├─ stage.hbs                 ← 노벨창 뼈대
│  ├─ keyword-manager.hbs       ← 키워드 등록부
│  └─ ref-page.hbs              ← 내보내기용 서브 HTML
└─ scripts/
   ├─ module.js                 ← init/ready, 훅 배선, 공개 API
   ├─ constants.js              ← MODULE_ID, FLAG 키, 템플릿 경로, L()
   ├─ compat.js                 ← v13/v14 분기 유틸 (§10)
   ├─ settings.js
   ├─ expressions.js            ← 표정 데이터 모델·검증·대체 순서 해석·메시지 플래그 동결
   ├─ expression-config.js      ← AppV2 편집기 + 시트 헤더 버튼/디렉터리 컨텍스트 메뉴
   ├─ expression-picker.js      ← 발화자 바 확장(현재 표정 선택), 인라인 `{표정}` 태그
   ├─ stage-state.js            ← **순수 리듀서** (Foundry 의존 없음, 로그 플레이어와 공유)
   ├─ stage-dom.js              ← **순수 DOM 렌더러** (Foundry 의존 없음, 로그 플레이어와 공유)
   ├─ stage.js                  ← 월드 안 노벨창: 마운트, 메시지 훅→리듀서, 토글, 재구성
   ├─ links.js                  ← 키워드 해석, 인리처, 클릭 처리, 참조 이미지 데이터
   ├─ keyword-manager.js        ← AppV2 키워드 등록부
   ├─ socket.js                 ← GM 전원 켜기/끄기/무대 비우기, 플레이어 키워드 등록 위임
   └─ archive-ext.js            ← chat-tools 직렬화/내보내기 훅 구현 (§8)
```

### 2.1 의존 관계와 역할 분담

```
Foundry 훅 ──► gatos-chat-tools (포트레잇·발화자 바·아카이브·내보내기 파이프라인)
                    │  확장 지점(§9): registerPortraitProvider, gctSerializeMessage,
                    │  gctSpeakerBar*, gctExportRender, gctExportBundle, api.lookupPortrait
                    ▼
             gatos-visual-novel
               ├─ expressions.js  → chat-tools 포트레잇 공급자로 face 제공
               ├─ expression-picker.js → chat-tools 발화자 바에 선택 UI 삽입
               ├─ stage.js        → 노벨창 (chat-tools와 무관하게 createChatMessage로 동작)
               ├─ links.js        → 인리처·참조 이미지 (chat-tools와 무관)
               └─ archive-ext.js  → chat-tools 아카이브 JSON·내보내기 번들에 필드/파일 추가
```

- 노벨창과 키워드 링크 자체는 chat-tools 없이도 동작하도록 짜되, 모듈 활성 조건은 `relationships.requires`로 chat-tools를 강제한다(설치 단순화). `ready`에서 `game.modules.get("gatos-chat-tools")?.active`와 `api.registerPortraitProvider` 존재 여부를 검사해 없으면 경고 알림 + 포트레잇/아카이브 연동만 비활성.
- `module.json`: `"socket": true`, `relationships.requires: [{ id: "gatos-chat-tools", type: "module", compatibility: { minimum: "0.2.0" } }]`.

---

## 3. 표정/스탠딩 데이터 모델

### 3.1 액터 플래그

```jsonc
// actor.flags["gatos-visual-novel"]
{
  "expressions": [
    { "id": "default", "name": "기본", "face": "", "stand": "" },   // 항상 0번, 삭제 불가
    { "id": "k3f9a2", "name": "웃음",  "face": "path/a.webp", "stand": "path/a-stand.png" },
    { "id": "p0q1zz", "name": "분노",  "face": "", "stand": "path/b-stand.png" }
  ],
  "stand": { "scale": 1, "offsetY": 0 }   // 액터 단위 스탠딩 보정(선택)
}
```

- `id`: `foundry.utils.randomID(6)`, `default`는 예약어. 이름은 액터 안에서 유일(인라인 태그 해석에 쓰므로 중복 시 저장 거부).
- `기본` 항목: 이름 고정(로컬라이즈 "GVN.Expression.Default"), 삭제·순서 이동 불가, `face`/`stand` 모두 비울 수 있음. **face가 비어 있으면 그 시점의 액터 이미지가 쓰인다**(저장하지 않고 해석 단계에서 대체).
- 플래그가 전혀 없는 액터는 `[{ id:"default", name:"기본", face:"", stand:"" }]`로 간주 (`getExpressions(actor)`가 항상 정규화된 배열을 돌려준다). 즉 모듈을 켜기만 해도 모든 액터가 `기본` 하나를 가진다.
- 편집 권한: 액터 OWNER 이상 또는 GM. 플래그 쓰기는 `actor.setFlag`가 아니라 `actor.update({ "flags.gatos-visual-novel.expressions": [...] })` 한 번으로(배열 전체 교체).
- 이미지 경로는 Foundry FilePicker가 주는 상대 경로(`worlds/...`, `modules/...`) 그대로. 외부 URL도 허용.

### 3.2 사용자별 "현재 표정"

```jsonc
// game.user.flags["gatos-visual-novel"].current
{ "<actorId>": "<expressionId>" }
```

- 발화자 바에서 고른 표정은 **사용자 플래그**에 액터별로 저장(플레이어 둘이 같은 액터를 쓰는 경우 서로 간섭하지 않음). 존재하지 않는 id면 `default`로 간주.
- 액터가 아닌 발화자(토큰만 있거나 alias만)에는 표정이 없다 → 키는 `actorId`가 있을 때만.

### 3.3 메시지 플래그 (생성 시 동결)

```jsonc
// message.flags["gatos-visual-novel"]
{
  "expression": {
    "id": "k3f9a2", "name": "웃음",
    "face":  "path/a.webp",        // §4 대체 순서를 적용한 최종 결과 (없으면 null)
    "stand": "path/a-stand.png",   // 동일
    "faceSource": "face",          // 디버그/뷰어용: face|stand|defaultFace|defaultStand|token|actor|null
    "standSource": "stand"
  },
  "refs": [ /* §7.3 */ ],
  "narration": false               // 인라인 태그 등으로 지정된 서술 모드(선택)
}
```

- chat-tools의 `flags.gatos-chat-tools.portrait`와 같은 원칙: **그 시점 이미지를 메시지에 고정**해 나중에 표정을 바꿔도 지난 카드/노벨창 재구성/아카이브가 변하지 않는다.
- 동결 시점: `preCreateChatMessage`(작성자 클라이언트). chat-tools의 발화자 고정 훅이 먼저 speaker를 바꾸므로 **그 뒤에 실행**되어야 한다 → chat-tools가 발화자 고정 처리 끝에 호출하는 `gctSpeakerResolved(message, data)` 훅(§9 #3)에서 동결한다. chat-tools가 없거나 구버전이면 `preCreateChatMessage`에 직접 등록(폴백).
- 작성자가 아닌 클라이언트에서는 아무것도 하지 않는다(`userId !== game.user.id`면 return).
- chat-tools 편집 창에서 화자를 바꾸면 chat-tools가 `portraitFlagUpdate`를 호출하듯, 이 모듈도 `updateChatMessage`(speaker 변경 감지, 작성자 또는 GM 클라이언트 하나만) 시 expression을 새 화자의 `default`로 다시 동결한다. 편집 창에 표정 선택 필드를 넣는 것은 선택 과제(§13).

---

## 4. 대체 순서(해석 규칙)

`expressions.js`의 `resolveImages({ actor, token, expressionId })` → `{ face, stand, faceSource, standSource, entry }`

| 용도 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 채팅 카드 **face** | 지정 항목 `face` | 지정 항목 `stand` | 기본 항목 `face` | 토큰 이미지 | 액터 이미지 |
| 노벨창 **stand** | 지정 항목 `stand` | 지정 항목 `face` | 기본 항목 `stand` | 토큰 이미지 | 액터 이미지 |

- "토큰 이미지" = chat-tools `lookupPortrait(speaker).token` (장면에 토큰이 있을 때의 `texture.src`, 없으면 null). "액터 이미지" = `actor.img`.
- 지정 항목이 `default`이면 1·3은 같은 값이므로 자연히 2단계(기본 항목의 반대 종류)→4→5로 흐른다.
- 액터가 없는 발화자: 1~3을 건너뛰고 토큰 → (없음). 액터·토큰 모두 없으면 `null` (카드 포트레잇 없음, 노벨창에 스탠딩 없음, 대사창만 표시).
- 결과가 null이 아니면 이미지 경로 문자열. 해석은 동기 함수여야 한다(preCreate 훅 안에서 호출).

**채팅 카드 적용**: chat-tools `registerPortraitProvider((message) => message.flags["gatos-visual-novel"]?.expression?.face ?? null)`. 공급자가 null을 돌려주면 chat-tools 기존 로직(동결된 토큰/액터 이미지)으로 떨어진다. 모듈 설치 전 메시지는 플래그가 없으므로 자연히 기존 동작.

---

## 5. 표정 UI

### 5.1 액터 표정 편집기 (`ExpressionConfig`, AppV2 + Handlebars)

- 열기: (a) 액터 시트 헤더 컨트롤 "표정/스탠딩" (AppV2 시트: `getHeaderControlsApplicationV2` 훅에서 `app.document instanceof Actor`일 때 push; AppV1 시트(pf1 등): `getActorSheetHeaderButtons`), (b) 액터 디렉터리 항목 우클릭 메뉴 (`getActorContextOptions`; v13 훅명은 compat.js에서 확정), (c) 매크로 `api.openExpressionConfig(actor)`.
- 레이아웃: 왼쪽 항목 목록(드래그 순서 변경, `기본`은 맨 위 고정), 오른쪽 선택 항목 편집: 이름, face 파일 선택(`file-picker` 입력, type image) + 미리보기, stand 파일 선택 + 미리보기, "비우기" 버튼, 항목 삭제(기본 제외), 아래쪽 액터 스탠딩 보정(scale 0.5~2, offsetY -50~50%).
- 미리보기 패널: 현재 항목의 §4 대체 결과를 그대로 보여준다("이 항목으로 말하면 카드엔 이 얼굴, 노벨창엔 이 스탠딩" — 출처 라벨 표시).
- 저장: 폼 제출 시 전체 배열 검증(이름 중복/빈 이름 거부) 후 `actor.update` 한 번. 저장 후 `updateActor` 훅으로 발화자 바와 열린 편집기가 갱신된다.
- 폴더 일괄 등록(선택 과제): 폴더를 고르면 `얼굴_이름.png` / `스탠딩_이름.png` 같은 파일명 규칙으로 항목을 자동 생성. 기획 단계에서는 P2.

### 5.2 발화자 바 표정 선택 (`expression-picker.js`)

- chat-tools 발화자 바(`.gct-speaker-bar`) 아래에 **표정 스트립**을 삽입: 현재 발화자 액터의 항목을 face 썸네일(없으면 stand 썸네일, 둘 다 없으면 이름 칩)로 나열, 클릭 시 사용자 플래그 `current[actorId]` 갱신 + 발화자 바 초상화도 그 face로 교체(`gctSpeakerBarResolve` 훅에서 `info.img`를 덮어씀).
- 발화자에 액터가 없으면 스트립 숨김. 잡담 모드(`gct-cc-mode`)에서도 숨김.
- 훅: `gctSpeakerBarMounted(bar)`에서 스트립 DOM 생성, `gctSpeakerBarUpdated(bar, info)`에서 내용 갱신.
- 스트립 끝의 톱니 아이콘으로 §5.1 편집기 열기(권한 있을 때만).
- 클라이언트 설정 `pickerMode`: 썸네일 | 이름 | 숨김(드롭다운만).

### 5.3 인라인 표정 태그 (월드 설정으로 on/off, 기본 on)

- 메시지 본문이 `{표정이름}`으로 시작하면(예: `{웃음} 와, 너 진철이랑 해변도 갔었어?`) 그 메시지만 해당 표정으로 보내고, 설정 `inlineTagSticky`가 켜져 있으면 현재 표정도 바꾼다. 태그는 본문에서 제거.
- 구현: `chatMessage` 훅(chat-tools 잡담 훅과 공존: 잡담이면 무시). 태그를 떼고 `flags.gatos-visual-novel.expressionOverride = id`를 chatData에 실어 보내면, 동결 단계가 `current` 대신 이 값을 쓴다. 이름이 액터 항목에 없으면 태그를 그대로 둔다(오탐 방지). `{{키워드}}`(§7)와 구분: 중괄호 두 겹은 링크, 중괄호 한 겹은 표정. 대괄호 계열(`[[…]]` 루비/인라인 굴림, `[원문|루비]` character-chat-selector 루비)은 이 모듈이 전혀 건드리지 않는다. 정규식 `/^\s*\{([^{}|]+?)\}\s*/` (중괄호 두 겹은 제외).

---

## 6. 노벨창(스테이지)

### 6.1 마운트 위치와 DOM

```html
<!-- #interface > #ui-middle 안, #ui-top 과 #ui-bottom 사이 -->
<section id="gvn-stage" class="gvn-stage">
  <div class="gvn-stands">            <!-- pointer-events: none -->
    <figure class="gvn-stand active" data-key="Actor.abc" data-slot="2" style="--scale:1;--offset-y:0">
      <img class="gvn-stand-img layer-a" src="...">
      <img class="gvn-stand-img layer-b" src="...">   <!-- 크로스페이드용 2중 레이어 -->
    </figure>
    ...
  </div>
  <div class="gvn-ref" hidden>         <!-- 참조 이미지/텍스트 패널, pointer-events: auto -->
    <img ...> 또는 <div class="gvn-ref-text">...</div>
    <button class="gvn-ref-close">×</button>
  </div>
  <div class="gvn-dialogue">           <!-- pointer-events: auto -->
    <div class="gvn-name">민아</div>
    <div class="gvn-text">와, 너 진철이랑 해변도 갔었어?</div>
    <div class="gvn-dialogue-tools">▾(접기) · ⟲(무대 비우기, GM) · ⨯(노벨창 끄기)</div>
  </div>
</section>
```

- v13 `templates/views/game.hbs` 기준 `#interface > #ui-middle`은 `#ui-top`(헤더)·`#ui-bottom`(푸터=핫바)만 가진 flex column이다. 스테이지는 그 사이에 `flex: 1 1 auto; position: relative; min-height: 0`로 끼워 넣는다 → 사이드바(채팅창)와 핫바(Taskbar)는 가려지지 않고, 사이드바 접기/펼치기에 자동으로 따라간다.
- `#ui-middle`이 없으면(v14 레이아웃 변경 대비) `#interface`에 `position:absolute; inset:0; right: <#sidebar 너비>`로 붙이는 폴백(compat.js `mountPoint()`).
- **클릭 통과**: 스테이지 루트와 스탠딩은 `pointer-events: none`(캔버스 토큰 조작 유지). 대사창·참조 패널·버튼만 `pointer-events: auto`. 스탠딩 우클릭 제거(GM)는 `Alt`를 누른 동안만 `pointer-events`를 켜는 CSS 클래스(`body.gvn-alt`)로 처리.
- 캔버스가 없는(장면 미활성) 상태에서도 동작해야 하므로 `canvasReady`에 의존하지 않고 `ready`에서 마운트, `renderSidebar`/`collapseSidebar`에서 마운트 여부 재확인.

### 6.2 상태와 리듀서 (`stage-state.js`, Foundry 의존 없음)

```js
// 입력 엔트리: 실시간 ChatMessage와 아카이브 직렬화 메시지를 같은 모양으로 정규화한 것
Entry = {
  id, timestamp,
  kind: "speech" | "narration" | "ignore",
  key: "Actor.<id>" | "Token.<sceneId>.<tokenId>" | "Alias.<alias>" | null,  // 스탠딩 슬롯 키
  name,            // 이름표
  stand: string|null,
  face:  string|null,
  html,            // 대사창 본문 (렌더된 .message-content innerHTML, 주사위 툴팁 제거)
  refs: [ { uuid, type, name, img, text } ]
}

State = {
  slots: Array(maxSlots).fill(null),      // { key, name, stand, lastTs, messageId }
  activeKey: string|null,
  dialogue: { name, html, messageId, ts, emote } | null,
  ref: { refs, messageId } | null
}

apply(state, entry, { maxSlots, slotOrder }) → newState   // 불변, 순수
```

규칙:
- `kind === "ignore"`: 상태 불변.
- `speech`: (1) `key`가 이미 슬롯에 있으면 그 슬롯의 `stand`를 갱신(표정 변화 → 크로스페이드), 없으면 **빈 슬롯 중 `slotOrder` 우선순위가 가장 높은 곳**에 넣고, 빈 슬롯이 없으면 `lastTs`가 가장 오래된(가장 오래 말하지 않은) 슬롯을 비우고 넣는다. (2) `activeKey = key`. (3) `dialogue` 갱신. (4) `ref = refs.length ? {refs} : null`. `stand`가 null인 speech는 슬롯을 차지하지 않고 (2)~(4)만 적용(모두 회색이 됨).
- `narration`: 슬롯·activeKey 불변, `dialogue`(이름표 없음)·`ref`만 갱신.
- 슬롯 순서 `slotOrder` (6칸 기준, 0-based): `[2, 3, 1, 4, 0, 5]` — 중앙부터 바깥으로. `maxSlots`가 작으면 그 개수만큼 가운데 정렬된 순서를 생성(`centerOutOrder(n)`).
- 별도 액션: `remove(state, key)`, `clear(state)`, `withMaxSlots(state, n)`.

`toEntry(messageOrSerialized)`(stage.js/archive-ext.js 공용) 분류 규칙:

| 조건 | kind |
|---|---|
| `message.visible === false`(자기에게 오지 않은 귓속말/비공개) | ignore |
| chat-tools 잡담(`flags.gatos-chat-tools.chitchat` 또는 `chitchat:true`) | ignore |
| 굴림 메시지(`isRoll`) | 설정 `rollMode`: ignore(기본) / narration(플레이버 + 합계) |
| 화자에 actor 또는 token이 있고 style이 IC/EMOTE | speech (EMOTE는 이름표 + 기울임) |
| OOC(사용자 발언) | 설정 `oocMode`: ignore(기본) / narration |
| 화자 없음(시스템, alias만) | narration (alias가 있으면 이름표에 alias) |
| 플래그 `narration: true` | narration |

### 6.3 렌더러 (`stage-dom.js`, Foundry 의존 없음)

- `render(root, state, opts)`: 상태를 DOM에 반영. 슬롯 변화는 CSS 전환(등장 fade-up 250ms, 퇴장 fade 200ms, 교체는 2중 레이어 크로스페이드 200ms). 활성/비활성은 `.active` 토글 → 비활성은 `filter: grayscale(1) brightness(.55)`.
- 이미지 URL 변환은 `opts.resolveUrl(path)` 콜백으로 주입(월드 안: 그대로/`foundry.utils.getRoute`, 내보낸 폴더: 상대 경로) → 로그 플레이어가 같은 파일을 그대로 쓴다.
- 대사창: `opts.typewriter`(글자당 ms, 0=즉시)로 타자 효과; HTML 본문이므로 텍스트 노드를 span으로 쪼개 순차 표시. 복잡하면 P2로 미루고 즉시 표시.
- 참조 패널: `refs[0]`에 img가 있으면 이미지(최대 60% 높이), 없고 text가 있으면 스크롤 텍스트 패널, 여러 개면 하단에 썸네일 탭. 클릭 → `opts.onRefClick(ref)`.
- 스탠딩 크기: `height: calc(var(--gvn-stand-height) * 1%)`(기본 85% of 스테이지 높이, 설정) × 액터 scale, 하단 정렬(대사창 위). 6슬롯은 가로를 6등분한 열의 가운데에 배치(`left: calc((slot + .5) * 100% / 6); transform: translateX(-50%)`).
- 이미지는 `new Image()`로 미리 로드한 뒤 교체(깜빡임 방지).

### 6.4 월드 연결 (`stage.js`)

- `createChatMessage(message)`: `if (!message.visible) return;` → `toEntry(message)`(본문 HTML은 `await message.renderHTML()`에서 `.message-content` innerHTML — chat-tools `api.renderMessageContent` 재사용) → `state = apply(state, entry)` → `render`.
- `updateChatMessage`: 대상이 `dialogue.messageId`이면 본문·이름 갱신(chat-tools 편집 반영). `deleteChatMessage`: 대사창의 메시지가 지워지면 대사창 비움(슬롯은 유지).
- **재구성**: `ready` 및 노벨창을 켤 때 `game.messages.contents`의 최근 `rebuildCount`(기본 40)개를 오래된 순으로 `apply`해 현재 무대를 복원(새로고침·늦게 접속한 플레이어도 같은 무대를 본다). 재구성 중엔 애니메이션 끔.
- 자동 퇴장: 설정 `idleMinutes`(0=없음) 경과 시 슬롯 제거(1분 타이머).
- 전투 자동 숨김: 설정 `hideInCombat`이 켜져 있으면 `combatStart`/`updateCombat(active)`에 숨기고 `deleteCombat`에서 되살림(상태는 유지, 표시만).

### 6.5 켜기/끄기

- 클라이언트 설정 `stageEnabled`(기본 켬). 채팅 컨트롤 바(`#chat-controls`, chat-tools 아카이브 버튼 옆)에 토글 버튼(아이콘 `fa-masks-theater`; chat-tools `injectChatButton`과 같은 방식으로 `renderChatInput`/`renderChatLog`에 삽입). 대사창의 ⨯ 버튼도 같은 설정을 끈다. 키바인딩 `toggleStage`(기본 미지정).
- 끄면 `#gvn-stage`를 `hidden` 처리(상태는 메모리에 유지하고 계속 갱신 → 다시 켜면 즉시 현재 무대).
- **GM 전원 제어**: 토글 버튼 우클릭 컨텍스트 메뉴(GM만): "전원 켜기", "전원 끄기", "전원 무대 비우기". `socket.js`가 `game.socket.emit("module.gatos-visual-novel", { type: "stage", enabled, userId })` / `{ type: "clear" }`를 보내고, 각 클라이언트는 `game.settings.set(MODULE_ID, "stageEnabled", enabled)`로 **자기 클라이언트 설정을 바꾼다**(강제 후에도 각자 다시 끌 수 있음). 송신자(GM) 본인도 적용. 수신 측은 `game.users.get(userId)?.isGM` 검증.
- 월드 설정 `playersCanToggle`(기본 켬): 끄면 플레이어의 토글 버튼이 숨겨지고 GM 제어만 유효.

---

## 7. 키워드 링크와 참조 이미지 (`links.js`, `keyword-manager.js`)

### 7.1 문법

- `{{키워드}}` 또는 `{{키워드|표시 텍스트}}`. 키워드는 (1) 키워드 등록부의 항목, (2) 월드 문서 이름(액터 → 아이템 → 저널 → 저널 페이지 순, 대소문자 무시, 정확 일치만), (3) `저널명/페이지명` 형식. 컴펜디엄은 P2.

**표기 선정 근거(2026-10-21 조사)** — 설치된 채팅 관련 모듈과 Foundry 코어가 채팅 본문에서 해석하는 기호를 조사해 충돌이 없는 것을 골랐다.

| 후보 | 충돌 | 판정 |
|---|---|---|
| `[[키워드]]` | Foundry 인라인 굴림 `[[/r 1d20]]`·`[[1d6]]`, 사용자 루비 표기 | 불가 |
| `[키워드\|표시]` | character-chat-selector 루비 `/\[(.*?)\|(.*?)\]/` | 불가 |
| `((키워드))` | 한국어 RP에서 속마음/OOC 관습, 일반 괄호와 혼동 | 불가 |
| `%키워드%` | `50% 와 30%` 같은 문장에서 오탐 | 불가 |
| `<<키워드>>` | HTML 파서·DOMPurify(character-chat-selector)가 `<`를 태그로 취급 | 불가 |
| `!키워드`, `` `키워드` `` | chat-tools 잡담 트리거(문장 앞 `!`, 백틱), 마크다운 코드 | 불가 |
| `#키워드` | 마크다운 제목(줄 앞 `# `)과는 공존 가능하나 표시 텍스트 형식이 없음 | 보류 |
| `@kw[키워드]{표시}` | 없음(Foundry 인리처 관례, 코어는 등록된 문서 타입만 매칭) | 가능, 장황함 |
| `::키워드\|표시::` | 없음 | 가능, 2순위 |
| **`{{키워드\|표시}}`** | 채팅 본문에서는 없음(marked·mrkb 마크다운, Foundry 인리처, chat-tools 모두 `{{`를 해석하지 않음). Handlebars는 .hbs 템플릿 파일 안에서만 문제 → 구현 주의사항(§15 3번) | **채택** |

같은 이유로 표정 인라인 태그(§5.3)도 대괄호 대신 중괄호 한 겹 `{표정}`을 쓴다. `[[…]]`와 `[…\|…]`는 루비용으로 비워 둔다. character-chat-selector의 루비 정규식 `/\[(.*?)\|(.*?)\]/`은 `[`부터 다음 `|`…`]`까지 한 번에 잡으므로, 한 메시지에 루비와 이 모듈 문법이 섞여도 중괄호 문법은 그 범위에 들어가지 않는다. 다만 `chatMessage` 훅 실행 순서는 모듈 로드 순서를 따르므로, `{표정}` 태그는 다른 모듈이 본문을 가공하기 전에 떼어 내도록 훅을 `init`에서 바로 등록한다(chat-tools 잡담 훅과는 "잡담이면 무시"로 공존).
- 같은 메시지에 여러 링크 가능. 해석 실패 시 원문 그대로 남기고 작성자에게 경고 알림(`GVN.Link.NotFound`).

### 7.2 권한

- 작성자가 GM이거나 대상에 **OBSERVER 이상**(월드 설정 `linkPermission`: LIMITED/OBSERVER/OWNER, 기본 OBSERVER)일 때만 링크가 만들어진다. 권한이 없으면 해석 실패와 같이 처리.
- 열람자: 클릭 시 `doc.testUserPermission(game.user, linkPermission)`을 통과하면 `doc.sheet.render(true)`(저널 페이지는 `journal.sheet.render(true, { pageId })`), 아니면 경고. 참조 이미지도 같은 권한을 가진 사용자에게만 표시(아니면 이름만 적힌 자물쇠 카드).
- 구현 메모: Foundry의 기본 콘텐츠 링크 클릭 처리는 LIMITED 권한만 요구하므로, `renderChatMessageHTML`에서 `.gvn-ref-link`에 캡처 단계 클릭 리스너를 달아 권한을 우리 설정으로 검사하고 `stopPropagation`한다.

### 7.3 생성 시 처리 (작성자 클라이언트, `preCreateChatMessage`)

1. `message.content`에서 `{{...}}`를 찾아 해석.
2. 본문의 각 매치를 표준 콘텐츠 링크 `@UUID[<uuid>]{<표시 텍스트>}`로 치환 → Foundry가 `a.content-link`로 렌더하고, chat-tools 아카이브·내보내기 HTML에도 그 앵커가 그대로 남는다.
3. `flags.gatos-visual-novel.refs`에 참조 정보를 동결:
   ```jsonc
   { "uuid": "JournalEntry.x.JournalEntryPage.y", "type": "JournalEntryPage", "name": "해변 사진",
     "keyword": "해변사진", "img": "worlds/.../beach.jpg",   // 아래 규칙으로 뽑은 대표 이미지(없으면 null)
     "text": "<p>…</p>" }                                   // 저널 텍스트 페이지만, 길이 제한 20KB
   ```
   대표 이미지: Actor → `actor.img`(모듈 표정 `기본` face가 있으면 그것) · Item → `item.img` · JournalEntry → 첫 image 페이지의 `src`, 없으면 null(text는 첫 text 페이지) · JournalEntryPage(image) → `src`, (text) → `text.content`, (pdf/video) → null.
4. 렌더 시(`renderChatMessageHTML`) `a.content-link[data-uuid]`가 refs에 있으면 `gvn-ref-link` 클래스와 `data-gvn-ref-index`를 붙인다. 노벨창 참조 패널은 §6의 `ref` 상태로 표시.

왜 인리처 치환이 아니라 preCreate 치환인가: 권한 판단은 **작성자** 기준이어야 하고, 아카이브/내보내기/로그 플레이어가 Foundry 없이도 링크 대상을 알아야 하므로 메시지에 uuid와 이미지를 고정한다. 추가로 `CONFIG.TextEditor.enrichers`에 `{{...}}` 인리처도 등록해 **저널/아이템 설명 등 채팅 밖**에서도 같은 문법이 링크로 보이게 한다(거기서는 열람자 권한으로 해석해 `doc.toAnchor()`를 반환, 참조 이미지 없음).

### 7.4 키워드 등록부

- 월드 설정 `keywords`(config:false): `[{ keyword, uuid, addedBy }]`. 키워드는 전역 유일, 대소문자 무시.
- `KeywordManager`(AppV2): 목록/검색, 추가(문서를 드래그 앤 드롭하거나 UUID 입력 + 키워드), 삭제. GM은 전부, 플레이어는 자신이 OBSERVER 이상인 문서만 추가·자기 항목만 삭제. 플레이어 쓰기는 월드 설정을 직접 못 바꾸므로 **소켓으로 GM 클라이언트에 위임**(`{type:"keyword", op:"add"|"remove", entry}`; GM이 접속해 있지 않으면 안내).
- 열기: 채팅 컨트롤 토글 버튼 컨텍스트 메뉴 "키워드 등록부", 매크로 `api.openKeywordManager()`.
- 채팅 입력 자동완성(`{{` 입력 시 후보 팝업)은 P2.

---

## 8. 아카이브·내보내기 연동 (`archive-ext.js`)

### 8.1 아카이브 JSON (chat-tools 형식 v2)

chat-tools `serializeMessage` 결과에 `gctSerializeMessage` 훅으로 다음을 추가한다. 기존 필드 `img`(카드 이미지 = 표정 face가 적용된 값), `alias`(이름), `user`(플레이어), `timestamp`(생성일시)는 chat-tools가 이미 기록한다.

```jsonc
{
  "...": "chat-tools 기존 필드",
  "img": "path/a.webp",            // 포트레잇 공급자 덕분에 표정 face가 들어감
  "vn": {
    "expression": { "id": "k3f9a2", "name": "웃음", "face": "path/a.webp", "stand": "path/a-stand.png" },
    "refs": [ { "uuid": "...", "type": "...", "name": "...", "img": "...", "text": "..." } ],
    "kind": "speech",              // toEntry 분류 결과(플레이어가 재분류하지 않아도 되게)
    "key": "Actor.abc"
  }
}
```

- 모든 메시지에 기록한다(경로 문자열뿐이라 용량 부담 없음). "바뀔 때만" 압축은 하지 않는다 — 플레이어가 임의 위치로 탐색(seek)하려면 메시지마다 완전한 정보가 있는 편이 단순하다.
- 아카이브 헤더에 `"vn": { "version": 1, "maxSlots": 6, "slotOrder": [2,3,1,4,0,5] }`를 `gctArchiveHeader` 훅으로 추가(플레이어가 무대 규칙을 재현).
- 뷰어(chat-tools) 카드: 포트레잇 툴팁에 표정 이름 표시(§9 #6). 선택.

### 8.2 내보내기 (zip / 폴더 모드)

chat-tools 내보내기 파이프라인에 두 훅이 추가된다(§9 #4). 이 모듈의 처리:

1. **`gctExportRender(doc, ctx)`** (DOM 단계, 모드 공통)
   - `ctx.mode`가 `zip`/`dir`일 때: 메시지의 `vn.refs`에 해당하는 `a.content-link[data-uuid]`를 `<a class="ref-link" href="refs/<slug>.html" target="_blank" rel="noopener">`로 바꾼다. `single`/`window` 모드에서는 `href="#"` + `title`에 문서 이름(서브 HTML 없음).
   - 카드 포트레잇 `img.portrait`는 chat-tools가 이미 `portraits/`로 상대화한다. 표정 이름을 `data-expression` 속성으로 붙인다.
2. **`gctExportBundle(bundle, ctx)`** (파일 단계, zip/dir만)
   - `bundle.files`(Map<경로, string|Blob|URL>)에 추가:
     - `refs/<slug>.html` — `ref-page.hbs`로 렌더: 제목, 종류, 이미지(`refs/images/<파일명>`), 텍스트(저널 텍스트 페이지 HTML, 이미지 src 절대화→번들화), "채팅 로그로 돌아가기" 링크. CSS는 `../chat-styles.css` 공유 + 소량 인라인.
     - `refs/images/*` — 참조 이미지 원본(Map 값에 URL 문자열을 넣으면 chat-tools `fetchFiles`가 받아 온다).
     - `stands/*`, `faces/*` — 메시지에 등장한 모든 stand/face 이미지(로그 플레이어 대비). 설정 `exportStands`(기본 켬)로 끌 수 있음.
     - `log.json` — chat-tools가 zip/dir에 기본으로 넣는 직렬화 메시지 배열 + 헤더에, `gctExportLog(log, ctx)` 훅으로 `vn.expression.face/stand`·`vn.refs[].img`를 **번들 상대 경로**로 치환하고 `vn.refs[].href = "refs/<slug>.html"`, 헤더 `vn: { maxSlots, slotOrder }`를 추가한다.
   - slug: `<type>-<uuid 뒤 8자>` (파일명 안전). 같은 문서는 한 번만.
3. 단일 HTML 모드: refs 서브 페이지 없음(요구사항대로). 참조 이미지를 `<details>`로 카드 아래에 data URI로 인라인하는 것은 P2.

### 8.3 로그 플레이어 대비 (이번에 만들지 않음, 형식만 고정)

- **입력 두 가지**: (A) 월드 안: chat-tools 아카이브 JSON(§8.1) — 이미지 경로는 월드 상대 경로 → `foundry.utils.getRoute`; (B) 로컬: 내보낸 폴더의 `log.json` — 모든 경로가 번들 상대 경로.
- **재생 엔진** = `stage-state.js`(리듀서) + `stage-dom.js`(렌더러). 둘 다 Foundry 전역을 참조하지 않으므로 (B)용 `player/player.html` + 두 파일 복사본을 내보내기 번들에 넣기만 하면 된다. 그래서 이 두 파일은 **`import`가 서로와 상수뿐**이어야 하고, `game`, `foundry`, `ui`, `Hooks`, `CONFIG`를 절대 쓰지 않는다(코드 리뷰 항목).
- 플레이어 UI(미래): 재생/일시정지/다음/이전/속도/탐색 바/타자 효과, 메시지마다 `apply`한 상태 스냅샷을 캐시해 뒤로 가기 지원. 메시지 `kind`·`key`를 JSON에 이미 기록하므로 분류 코드 없이 재생 가능.
- (A)의 월드 안 플레이어는 노벨창과 같은 `#gvn-stage` 컨테이너를 "재생 모드"로 전환해 쓰고(라이브 훅 일시 차단), (B)는 전체 화면 페이지.

---

## 9. gatos-chat-tools 선행 변경 (v0.1.0 → v0.2.0)

이 모듈이 요구하는 **확장 지점**. chat-tools 단독 동작은 그대로여야 한다.

| # | 파일 | 변경 | 용도 |
|---|---|---|---|
| 1 | `portrait.js` | `registerPortraitProvider(fn)` 추가. `portraitFor(message)`가 공급자들을 등록 순서로 호출해 첫 non-null `img`를 쓰고, 없으면 기존 로직. `applyPortrait`·`serializeMessage`는 `portraitFor`를 쓰므로 자동 반영 | 표정 face를 카드·뷰어·아카이브 `img`에 적용 |
| 2 | `archive.js` | `serializeMessage` 끝에 `Hooks.callAll("gctSerializeMessage", message, data)`; `saveArchive`에서 헤더 작성 후 `Hooks.callAll("gctArchiveHeader", archive)`; 아카이브 `version: 2` | `vn` 필드 추가 |
| 3 | `speaker-bar.js` | `createBar` 끝 `Hooks.callAll("gctSpeakerBarMounted", bar)`; `updateSpeakerBar`에서 `info` 계산 후 `Hooks.callAll("gctSpeakerBarResolve", info)`(img 덮어쓰기 허용) → 적용 후 `Hooks.callAll("gctSpeakerBarUpdated", bar, info)`; `onPreCreateChatMessage`(발화자 고정) 끝에 — 고정이 없어 바로 return하는 경로를 포함해 — `Hooks.callAll("gctSpeakerResolved", message, data, options, userId)` | 표정 스트립 삽입, 바 초상화 교체, 동결 순서 보장 |
| 4 | `export.js` | 파이프라인을 `buildBundle(messages, meta, mode)` → `{ html, css, files: Map }`로 정리. `renderDocument` 직후 DOM(`DOMParser`)에 대해 `Hooks.callAll("gctExportRender", doc, ctx)`; zip/dir에서 `relinkImages` 후 `Hooks.callAll("gctExportBundle", bundle, ctx)`; `fetchFiles`가 Map 값이 문자열 URL이면 fetch, Blob/string이면 그대로 기록. zip/dir에 `log.json`(직렬화 메시지 + 헤더) 기본 포함, `Hooks.callAll("gctExportLog", log, ctx)`. `ctx = { mode, meta, messages, relink(url, folder) → 번들 경로 }` | 서브 HTML·stands·log.json |
| 5 | `module.js` api | `lookupPortrait`, `registerPortraitProvider`, `htmlToText`, `renderMessageContent`, `EXPORT_CSS` 노출 | 재사용 |
| 6 | `viewer.js` / `message-list.hbs` | 카드 포트레잇 `title`에 `vn.expression.name`이 있으면 표시(선택) | 뷰어 표정 확인 |
| 7 | `module.json` | `version: 0.2.0`, `compatibility.verified: "14"`(v14 검증 후) | |

README의 "아카이브 JSON 형식" 절에 v2 필드와 훅 목록을 추가한다.

---

## 10. v13 / v14 호환 지침 (`compat.js`)

- 조사 결과(2026-10-21): v14 안정판은 14.359(2026-04-01)부터 14.368(2026-09-16)까지 나와 있다. v14 주요 변경은 Scene Levels, Active Effects V2(`changes`→`system.changes`), Scene Regions V2, ProseMirror 개선, **AppV2 팝아웃 창**, TinyMCE 제거. 이 모듈은 이들 중 어느 것도 직접 쓰지 않는다. 채팅/사이드바 훅의 v14 변경은 공식 노트에서 확인되지 않았으므로 **구현 시 v14 스크래치 서버에서 아래 항목을 실측**한다.
- 반드시 추상화할 지점(모두 `compat.js` 한 곳):
  - `mountPoint()` — `#ui-middle` 존재 여부에 따른 노벨창 부모 결정.
  - `actorSheetHeaderHook()` — AppV2 시트 `getHeaderControlsApplicationV2` vs AppV1 `getActorSheetHeaderButtons`(v14에서 AppV1 시트가 남아 있는 시스템 대비 둘 다 등록, 중복 삽입 방지).
  - `actorContextHook()` — 액터 디렉터리 컨텍스트 메뉴 훅 이름(v13: `getActorContextOptions`; 실측 후 확정).
  - `FilePicker()` → `foundry.applications.apps.FilePicker.implementation`, `TextEditor()` → `foundry.applications.ux.TextEditor.implementation`, `renderTemplate` → `foundry.applications.handlebars.renderTemplate`.
  - `generation = game.release.generation`로 분기하되, 분기는 compat.js 밖에서 금지.
- 전역 deprecated API(`TextEditor`, `FilePicker`, `renderTemplate`, `$`) 사용 금지. `renderChatMessageHTML`(HTMLElement) 사용, `renderChatMessage`(jQuery) 금지.
- 인리처: `CONFIG.TextEditor.enrichers.push({ id: "gvn-keyword", pattern, enricher, replaceParent: false })` — v13/v14 공통(v13 코드에서 `CONFIG.TextEditor.enrichers` 순회 확인함).
- CSS: Foundry 테마 변수(`--color-text-primary` 등)에 기대지 말고 모듈 변수로 자체 테마(다크 기본, 대사창 반투명). chat-tools에서 배운 교훈: 모듈 CSS에서 Foundry의 `url()` 변수를 쓰면 경로가 깨진다.
- 팝아웃 채팅(`ChatLog` popout, v14 별도 창)에서는 노벨창을 띄우지 않는다(주 창만). `renderChatMessageHTML`은 사이드바·팝아웃 양쪽에서 오므로 메시지 id로 중복 처리를 막는다.

---

## 11. 설정 목록

| 키 | 범위 | 기본 | 설명 |
|---|---|---|---|
| `stageEnabled` | client | true | 노벨창 표시 |
| `playersCanToggle` | world | true | 플레이어가 노벨창을 직접 켜고 끌 수 있음 |
| `maxSlots` | world | 6 | 동시 스탠딩 수(1~6) |
| `standHeight` | client | 85 | 스탠딩 높이(스테이지 높이 %) |
| `dialogueOpacity` / `dialogueFontSize` | client | 0.8 / 18 | 대사창 스타일 |
| `typewriterMs` | client | 0 | 타자 효과(0=즉시) |
| `dimStyle` | client | grayscale | 비활성 스탠딩: grayscale / darken / none |
| `oocMode` / `rollMode` | client | ignore / ignore | OOC·굴림 메시지 처리(ignore/narration) |
| `rebuildCount` | client | 40 | 접속·켤 때 재구성할 최근 메시지 수 |
| `idleMinutes` | world | 0 | 말하지 않은 스탠딩 자동 퇴장(0=없음) |
| `hideInCombat` | client | false | 전투 중 자동 숨김 |
| `pickerMode` | client | thumbnails | 발화자 바 표정 스트립 표시 방식 |
| `inlineTag` / `inlineTagSticky` | world / client | true / false | `{표정}` 인라인 태그 |
| `linkPermission` | world | OBSERVER | 링크 생성·열람 최소 권한 |
| `showRefInStage` | client | true | 참조 이미지 패널 표시 |
| `exportStands` | world | true | 내보내기에 stands/faces 포함 |
| `keywords` | world(hidden) | [] | 키워드 등록부 |

---

## 12. 공개 API (`game.modules.get("gatos-visual-novel").api`)

`getExpressions(actor)`, `setExpressions(actor, list)`, `resolveImages({actor, token, expressionId})`, `getCurrentExpression(actorId)`, `setCurrentExpression(actorId, id)`, `openExpressionConfig(actor)`, `openKeywordManager()`, `stage: { enable(), disable(), toggle(), clear(), remove(key), getState(), rebuild() }`, `broadcastStage(enabled)`(GM), `resolveKeyword(text, user)`, `toEntry(message)`, `StageState`(리듀서 모듈), `StageDOM`(렌더러 모듈).

훅(이 모듈이 발생): `gvnStageChanged(state, entry)`, `gvnExpressionsUpdated(actor)`, `gvnRefOpened(ref)`.

---

## 13. 구현 단계 (마일스톤)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **M0** | chat-tools v0.2.0 확장 지점(§9) | chat-tools 단독으로 기존 기능 회귀 없음, 훅이 호출됨 |
| **M1** | 표정 데이터·편집기·대체 순서·발화자 바 스트립·메시지 플래그 동결·카드 포트레잇 | 표정을 고르고 말하면 카드에 face, 플래그에 face/stand 고정. face/stand 한쪽만 있는 항목 4가지 조합 모두 §4대로 |
| **M2** | 노벨창: 마운트·리듀서·렌더러·대사창·회색 처리·6슬롯 LRU·토글·GM 전원 제어·재구성·전투 숨김 | 플레이어 2명+GM 환경에서 같은 무대, 7번째 화자가 가장 오래된 스탠딩을 밀어냄, 새로고침 후 복원 |
| **M3** | 키워드 링크·권한·참조 패널·키워드 등록부·인리처 | 관찰자 권한 있는 플레이어만 링크 생성, 없는 사용자는 클릭 시 경고, 참조 이미지 표시 |
| **M4** | 아카이브 v2 필드·zip/폴더 내보내기 서브 HTML·stands·log.json | 내보낸 폴더를 브라우저로 열어 링크 클릭 시 새 창에 서브 HTML, log.json이 §8.2 형식 |
| **M5** | 타자 효과·인라인 태그·README·i18n(ko/en)·v14 실측 | v13·v14 스크래치 월드에서 §14 체크리스트 통과 |

선택 과제(P2): 폴더 일괄 등록, `{{` 자동완성, 단일 HTML 참조 인라인, 편집 창 표정 필드, 컴펜디엄 키워드, 배경 이미지(장면 배경을 노벨창 배경으로), 스탠딩 좌우 반전/위치 수동 지정, 참조 패널 고정(핀).

---

## 14. 테스트 계획

- 환경: 메모리의 스크래치 서버 방식(`--dataPath` 분리, worldbuilding 시스템 + lang-ko, chat-tools·visual-novel 정션). v14는 별도 설치본으로 같은 절차. GM 1 + 플레이어 2 브라우저 탭.
- 체크리스트:
  1. 액터에 표정 3개(face+stand / face만 / stand만) 등록 → 각 항목으로 발언 → 카드·노벨창 이미지가 §4 표와 일치(출처 라벨로 확인).
  2. `기본` 항목 삭제 버튼 없음, 이미지 비우면 액터 이미지로 대체.
  3. 토큰이 장면에 있을 때/없을 때 토큰·액터 대체 확인.
  4. 7명 순서대로 발언 → 슬롯 순서 `[2,3,1,4,0,5]`, 7번째가 1번째 화자를 밀어냄, 활성만 컬러.
  5. 귓속말 → 수신자 화면에만 반영. 잡담 → 무대 불변. OOC/굴림 → 설정대로.
  6. 토글 끄기/켜기 상태 유지, GM "전원 끄기" 후 플레이어가 다시 켤 수 있음, `playersCanToggle` off 시 버튼 숨김.
  7. 새로고침 → 최근 40개로 무대 복원.
  8. 링크: 플레이어 A(관찰자)·B(권한 없음)가 `{{저널명}}` 작성 → A만 링크 생성; B가 A의 링크 클릭 → 경고; 참조 이미지 A에게만.
  9. 아카이브 저장 → JSON에 `vn.expression`·`vn.refs`; 뷰어 카드 포트레잇이 face.
  10. zip/폴더 내보내기 → `refs/*.html`, `refs/images/`, `stands/`, `faces/`, `log.json`; 브라우저에서 링크 새 창.
  11. chat-tools 편집 창에서 화자 변경 → 카드 face·플래그 재동결.
  12. v14: 마운트 위치·시트 헤더 버튼·컨텍스트 메뉴·인리처·`renderChatMessageHTML` 동작.

---

## 15. 열어 둔 가정 (구현 전 확인 사항)

1. 표정 선택 위치는 **발화자 바**(chat-tools)로 가정했다. 채팅 입력창 옆 별도 버튼을 원하면 `expression-picker.js`만 바꾸면 된다.
2. 스탠딩 슬롯 키는 **액터 id** 기준(같은 액터의 토큰 여러 개 = 한 스탠딩). 토큰별로 나누려면 `toEntry`의 `key` 규칙만 바꾼다.
3. **확정(2026-10-21 사용자 승인)**: 키워드 링크 `{{키워드|표시}}`, 표정 인라인 태그 `{표정}`. 근거는 §7.1 표. `[[…]]`·`[원문|루비]`는 루비 표기에 쓰이므로 이 모듈은 대괄호를 전혀 해석하지 않는다. 정규식은 `/\{\{([^}|]+?)(?:\|([^}]+?))?\}\}/g`이며, 채팅 본문에 다른 모듈이 `{{`를 쓰는 경우(예: Handlebars 유사 문법)와 충돌하면 해석 실패로 두고 원문을 남긴다. 이 문법 문자열은 Handlebars 템플릿(.hbs) 안에 직접 적지 말고 JS·i18n 문자열에서만 만든다.
4. 링크 최소 권한은 설정으로 두되 기본 OBSERVER.
5. 참조 이미지는 **다음 speech/narration 메시지가 오면 사라진다**(링크 없는 메시지로 교체). 고정하고 싶으면 패널의 핀 버튼(P2).
6. `기본` 항목 이름은 고정(로컬라이즈). 바꿀 수 있게 하려면 인라인 태그 해석만 영향.
7. GM 전원 제어는 "각 클라이언트 설정을 바꾸는" 방식이라 플레이어가 되돌릴 수 있다. 되돌리지 못하게 하려면 `playersCanToggle`을 끈다.
8. 설치된 유사 모듈(`theatre`, `lichsoma-speaker-stage`, `cinematic-cut-ins`)과는 독립이며, 동시에 켜면 오버레이가 겹칠 수 있다. 이 모듈은 `#ui-middle` 안에 자리 잡으므로 `#interface`에 붙는 모듈보다 아래에 깔린다.

---

## 16. 구현 현황 (2026-10-22, M0~M5 구현)

v13.351 스크래치 월드(worldbuilding + lang-ko, GM + 플레이어 2명)에서 §14 체크리스트 1~11 통과. 12(v14 실측)는 v14 설치본이 없어 미실시 → `compatibility.verified`는 13으로 둠.

사양과 달라진 점(실측·구현 중 결정):
- **마운트 위치(§6.1)**: v13의 `#ui-middle`은 폭 60% 가운데 열이고 `#ui-top`/`#ui-bottom`이 각 50% 높이라 그 사이에 끼울 수 없다. 대신 `#interface` 맨 앞에 `position:absolute`로 붙이고 `#sidebar` 왼쪽 끝·`#hotbar` 위 끝까지의 여백을 ResizeObserver로 재서 `right`/`bottom`에 넣는다. `z-index: 1` — `#board`(0)보다 위, 뒤에 오는 `#hud`(1)와 UI 열(30)보다 아래.
- **stage.hbs / ref-page.hbs 없음**: 무대 골격은 `stage-dom.js`가 JS로 만든다(로그 플레이어가 Foundry 없이 재사용). 서브 HTML은 `gctExportBundle`이 동기 훅이라 템플릿(비동기) 대신 문자열로 만든다.
- **스탠딩 배치**: 설정 `standLayout` 추가 — `spread`(기본, 선 사람 수로 고르게 벌림·이동 애니메이션) / `fixed`(§6.3의 6등분 고정 칸).
- **인라인 표정 태그(§5.3)**: `chatMessage` 훅이 아니라 표정 동결 단계(`gctSpeakerResolved`, 발화자 고정 뒤)에서 처리한다. 최종 화자의 표정 목록으로 이름을 찾을 수 있고, 매크로로 만든 메시지에도 적용된다.
- **화자 변경 재동결(§3.3)**: `updateChatMessage` 대신 편집하는 클라이언트의 `preUpdateChatMessage`에서 같은 업데이트에 실어 보낸다(추가 업데이트 없음).
- **해석 실패 키워드**: 채팅 렌더링도 `CONFIG.TextEditor.enrichers`를 거치므로, 실패한 `{{…}}`는 첫 중괄호 뒤에 빈 `<span class="gvn-kw-raw">`를 넣어 인리처가 **보는 사람 권한**으로 다시 링크하지 못하게 한다. 노벨창 대사창의 링크(렌더된 HTML 사본)도 캡처 단계에서 같은 권한 검사를 거친다.
- **OOC 기본값**: v13은 토큰 없이 친 GM 서술도 OOC로 만든다 → `oocMode`에 `gmNarration`(기본: GM의 OOC만 서술) 추가.
- **전원 무대 비우기**: 소켓 대신 월드 설정 `stageClearedAt`(시각)을 바꿔 모든 클라이언트에 전파하고, 재구성 때 그 이전 메시지를 무시한다(새로고침해도 빈 무대 유지). 스탠딩 하나 내리기(Alt+우클릭)는 소켓.
- **분류 코드**: `scripts/entries.js`(`categorize`/`describe`/`toEntry`) 추가. 아카이브 `vn`에 `category`(hidden/chitchat/narration/roll/ooc/speech/emote, 클라이언트 설정과 무관), `name`, `standStyle`도 기록 — 플레이어가 자기 설정으로 `kind`를 다시 정할 수 있다.
- **chat-tools 0.2.0**: 포트레잇 공급자는 문자열 또는 `{img, label}`을 돌려줄 수 있고 직렬화에 `imgLabel`이 붙는다(뷰어·내보내기 툴팁). zip/폴더 내보내기에는 `log.json`이 항상 들어가며, `bundle.files` 값은 URL 문자열 / Blob / `{text}`. 내보낸 `<article>`에 `data-message-id`. 폴더 모드는 하위 폴더 중첩(`refs/images/`)을 지원한다.
- **미검증**: 폴더(showDirectoryPicker) 모드와 새 창 열기(`target=_blank`)는 앱 내 브라우저에서 실행할 수 없어, 같은 번들을 서버 폴더에 풀어 HTTP로 열어 서브 페이지·이미지·돌아가기 링크를 확인했다.
- **로그 플레이어(§8.3) 구현 (2026-10-22, 모듈 0.2.0)**: 로컬 형태는 사용자가 Rust(Tauri) 앱 대신 "내보내기에 player.html 동봉"을 골랐다(설치 없이 더블클릭·공유 가능; 메시지 본문이 HTML이라 어차피 웹 렌더러가 필요). 구조:
  - `scripts/player-core.js`(순수): `entryFromSerialized`/`buildEntries`(아카이브의 `vn`이 없으면 카드 포트레잇을 스탠딩으로), `createPlayer(root, messages, opts)`(25개마다 상태 스냅샷으로 탐색, 대사 길이 기반 자동 넘김, 재생 막대·메시지 목록 UI, 대사창 클릭=타자 끝내기/다음), `startLocal(config)`.
  - 월드 안: `log-player.js`(현재 로그 또는 chat-tools 아카이브 선택 → `stage.enterPlayback`). 재생 중 `draw()`는 실시간 상태를 화면에 그리지 않고 계속 갱신만 한다. 개인 재생(동기화 없음).
  - 로컬: `gctExportBundle`에서 `<번들 이름>.player.html` 생성 — `stage-state.js`·`stage-dom.js`·`player-core.js`를 `const NS = (() => {…})()` 클래식 스크립트로 변환해 인라인(파일 URL에선 모듈 import·fetch가 막히므로), 로그는 `<script type="application/json">`에 `<`를 이스케이프해 인라인, CSS는 visual-novel.css 전체 인라인, Font Awesome 대신 글리프(`buildStage({glyphs:true})`). 훅이 동기라서 세 파일과 CSS는 `ready`에서 미리 받아 둔다. `log.json` 메시지의 참조 링크는 `refs/*.html`로 바꾼다.
  - 아카이브 `vn`에 `authorGM` 추가(로컬에서 "GM의 OOC만 서술" 판정).
  - 확인: 월드 안 재생(단계·탐색·자동 재생·재생 중 실시간 갱신·끄기·노벨창 꺼진 상태), 구 아카이브 재생, Edge headless로 `file://` 실행(무대·참조 패널·회색 처리), HTTP로 키보드·목록·해시.
- **chat-tools 0.3.1 연동 (2026-10-22)**: chat-tools에 `registerViewerAction` 추가 → VN이 뷰어 툴바·선택 막대에 "노벨로 재생"(필터된/선택한 메시지) 등록. 내보내기 로그 JSON 이름을 `<페이지 이름>.log.json`(`bundle.logName`)으로 바꿔 같은 폴더에 여러 번 내보내도 덮어쓰지 않음. chat-tools의 메시지 이동(타임스탬프 변경)·복제(과거 시각으로 생성)는 VN 무대 재구성으로 처리(작성자 시계 오차 1분 허용).
- **로그 편집기 (2026-10-22, 모듈 0.3.0)**: 내보낸 `player.html` 전용 `scripts/player-editor.js`(순수, `PlayerCore`만 import). 사용자 요구: 잘못된 대사·표정·그림을 뒤늦게 고치고, 줄 삭제/삽입, 배경 지정.
  - 편집 대상은 로그의 직렬화 메시지 배열(불변 갱신 + undo/redo 스택 100). `vn.category`/`kind`/`key`/`name`/`expression`/`background`/`clearStands`, `html`/`content`/`alias`/`img`/`actor`/`style`을 고친다. 새 줄은 `id: ed…`, 타임스탬프는 이웃의 중간값(간격 2ms 미만이면 소수), 이동도 같은 규칙. 편집된 메시지에 `edited: true`, 로그 머리말에 `edited: {at, editor}`.
  - **배경**(P2였음)을 무대 리듀서/렌더러에 추가: 엔트리 `background`(undefined = 유지, null = 지움, 경로 = 설정)·`clearStands`, 새 kind `scene`(대사 없이 배경/스탠딩만). `.gvn-bg`는 `.gvn-stands` 앞의 두 겹 `<img>` 크로스페이드. 월드 무대는 배경 엔트리를 만들지 않으므로 캔버스를 가리지 않는다.
  - 그림 목록 = 로그에 나온 경로(스탠딩/얼굴/포트레잇/본문 img/참조) ∪ 폴더 연결 시 `stands/ faces/ backgrounds/ images/ portraits/ refs/images/` 실제 파일. "파일에서…"는 data URL로 즉시 반영하고 폴더 저장 때 해당 하위 폴더에 파일로 써서 경로로 바꾼다(내려받기 저장이면 data URL 그대로 포함).
  - 저장: File System Access(`showDirectoryPicker`, file://에서도 보안 컨텍스트라 사용 가능 — headless Edge로 확인)로 플레이어 파일이 있는 폴더를 고르게 하고 `<이름>.player.html`(현재 문서를 복제해 `#gvn-log`만 교체, 런타임 DOM 제거)·`<이름>.log.json`을 덮어쓴다. 미지원 브라우저는 다운로드. 초안은 localStorage `gvn-draft:<파일명>:<exportedAt>`.
  - `createPlayer`에 `reload(messages, {focusId})`·`onIndex(fn)`·`stateAt`·`root`/`bar`/`prefs` 노출, `entries`는 getter. `startLocal`의 `append ?? append` 버그(무대가 body로 옮겨지던 것) 수정, `history.replaceState`는 try/catch.
  - 월드 안 재생에는 편집기를 붙이지 않았다(월드 메시지 편집은 chat-tools 영역). 검증: 합성 번들을 HTTP로 띄워 텍스트/표정 전파/배경/장면 전환/삽입·이동·삭제/OOC 복원/undo·redo/화자 변경/페이지 재구성 round-trip/초안 복원을 스크립트로 확인, headless Edge 스크린샷으로 레이아웃 확인. 폴더 저장(네이티브 대화상자)은 자동화할 수 없어 코드 검토만 했다. 실제 Foundry 내보내기(`toClassicScript` 인라인)는 같은 정규식을 Node로 재현해 확인.
- **화면 설정 범위 변경 (2026-10-22)**: 스탠딩 배치·높이·회색 처리·대사창 불투명도·글자 크기·타자 효과를 클라이언트 → 월드(GM 기본값)로 옮기고, 클라이언트 설정 `displayOverrides`(`{key: value}`, 바꾼 키만)로 개인 덮어쓰기. 읽기는 모두 `display(key)`(settings.js). 개인 창은 `registerMenu("displayMenu", restricted:false)` → `display-config.js`. 이전 클라이언트 값은 이관하지 않음(이미 각자 바꿔 둔 값이 있었다면 GM 기본값으로 돌아감).
- **P2(§13) 미구현**: 폴더 일괄 등록, `{{` 자동완성, 단일 HTML 참조 인라인, 편집 창 표정 필드, 컴펜디엄 키워드, 좌우 반전, 핀. (배경은 0.3.0에서 내보낸 플레이어 한정으로 구현.)
