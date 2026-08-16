# FreeMind Online

브라우저에서 바로 쓰는 마인드맵 편집기입니다. [FreeMind](https://freemind.sourceforge.io/wiki/index.php/Main_Page) 데스크톱 프로그램의 사용감(중앙 주제에서 좌우로 뻗는 트리 구조, 키보드 중심 편집, `.mm` 파일 포맷)을 웹으로 옮겨 왔습니다.

빌드 도구나 서버 없이 정적 파일만으로 동작하는 순수 HTML/CSS/JavaScript(ES 모듈) 프로젝트입니다.

## 사용해 보기

로컬에서 정적 파일 서버로 열면 됩니다 (ES 모듈이라 `file://`로 직접 열면 브라우저가 막을 수 있습니다):

```bash
npx serve .
# 또는
python3 -m http.server 8000
```

이후 브라우저에서 `http://localhost:8000` 접속.

## 배포

`main` 브랜치에 푸시되면 `.github/workflows/deploy-pages.yml` 워크플로가 자동으로 GitHub Pages에 배포합니다. 저장소 Settings → Pages에서 Source를 "GitHub Actions"로 한 번 설정해 두면, 이후로는 `main`에 머지될 때마다 자동으로 최신 버전이 배포됩니다.

## 주요 기능

- 중심 주제를 기준으로 좌/우 양쪽으로 뻗는 자동 트리 레이아웃
- 노드 추가/편집/삭제, 접기·펼치기
- 드래그로 캔버스 이동(팬), 마우스 휠로 확대·축소
- 노드를 드래그해서 다른 노드의 하위로 재배치
- 노드 색상 지정
- 실행 취소 / 다시 실행 (Ctrl+Z / Ctrl+Shift+Z)
- 브라우저 `localStorage`에 자동 저장 — 새로고침해도 작업 내용 유지
- JSON 파일로 저장/열기 (이 앱 전용 포맷, 모든 정보 보존)
- FreeMind 네이티브 `.mm` 파일로 내보내기/가져오기 (데스크톱 FreeMind와 상호 호환)

## 키보드 단축키

| 동작 | 단축키 |
| --- | --- |
| 하위 노드 추가 | `Insert` |
| 형제 노드 추가 | `Enter` |
| 선택한 노드 편집 | `F2` 또는 더블클릭 |
| 편집 완료 | `Enter` (편집 중) |
| 편집 취소 | `Esc` |
| 노드 삭제 | `Delete` / `Backspace` |
| 접기/펼치기 | `Space` |
| 노드 간 이동(선택) | 방향키 |
| 형제 노드 순서 변경 | `Ctrl+↑` / `Ctrl+↓` |
| 상위/하위 레벨로 이동(승격·강등) | `Ctrl+←` / `Ctrl+→` |
| 실행 취소 / 다시 실행 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| JSON으로 저장 | `Ctrl+S` |

`Ctrl+←`/`Ctrl+→` 중 어느 쪽이 승격(상위 레벨로)인지 강등(하위 레벨로)인지는 노드가 루트의 왼쪽/오른쪽 중 어느 가지에 있는지에 따라 달라집니다 — 루트에서 멀어지는 방향이 항상 강등입니다.

마우스 오른쪽 클릭으로 컨텍스트 메뉴를 열 수도 있습니다.

## 프로젝트 구조

```
index.html          앱 셸 (툴바 / 캔버스 / 상태 표시줄)
css/styles.css       스타일
js/model.js          마인드맵 데이터 모델과 변경 함수
js/layout.js         트리 레이아웃 계산
js/measure.js        노드 박스 크기 측정 (실제 렌더링과 일치시키기 위함)
js/render.js         상태 → DOM/SVG 렌더링
js/interactions.js   마우스/키보드 이벤트 처리
js/io.js             저장/불러오기, JSON, FreeMind .mm 변환
js/undo.js           실행 취소/다시 실행 히스토리
js/main.js           앱 초기화 및 위 모듈들을 연결
```

## 알려진 제한사항 / 다음 단계

- 단일 문서만 지원 (여러 맵 탭/전환 기능 없음)
- FreeMind의 아이콘, 서식 있는 텍스트(richcontent), 첨부파일, 클라우드는 아직 미지원
- 협업/실시간 동기화 없음 (로컬 저장 및 파일 내보내기만 지원)

## 라이선스

이 저장소의 코드는 [MIT License](LICENSE)로 배포됩니다. FreeMind 자체는 GPL로 배포되는 별개의 프로젝트이며, 이 프로젝트는 FreeMind의 코드를 사용하지 않고 새로 작성된 독립 구현체입니다.
