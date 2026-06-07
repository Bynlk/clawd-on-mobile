<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Mobile</h1>
<p align="center">
  <sub>🍴 <a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a>의 Fork, 원작자 <a href="https://github.com/rullerzhou-afk">@rullerzhou-afk</a> — <a href="LICENSE">AGPL-3.0</a> 라이선스</sub>
</p>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">中文版</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
  ·
  <a href="README-desk.ko-KR.md">🖥️ 데스크톱</a>
</p>
<p align="center">
  <a href="https://github.com/Bynlk/clawd-on-mobile/releases"><img src="https://img.shields.io/github/v/release/Bynlk/clawd-on-mobile" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-lightgrey" alt="Platform">
</p>
<p align="center">
  <a href="https://github.com/Bynlk/clawd-on-mobile/stargazers"><img src="https://img.shields.io/github/stars/Bynlk/clawd-on-mobile?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
</p>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd on Mobile — AI 코딩 에이전트에 실시간으로 반응하는 픽셀 데스크톱 펫, 이제 Android 컴패니언 앱과 함께.">
</p>

**Clawd on Mobile**은 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desktop)에 **네이티브 Android 컴패니언 앱**을 추가합니다. 데스크톱 펫이 이제 휴대폰에서도 살아갑니다 — LAN으로 연결하면 모바일 펫이 생각하기, 타이핑, 건설, 수면 등 모든 상태를 실시간으로 미러링합니다.

데스크톱에서 긴 작업을 시작하고, 휴대폰을 들고 자리를 비운 뒤, 크랩이 완료를 알려주면 돌아오면 됩니다.

> 🖥️ 데스크톱 전용 README를 찾고 계신가요? **[README-desk.ko-KR.md](README-desk.ko-KR.md)**를 참조하세요.

---

## 📱 Android 컴패니언 앱

<p align="center">
  <img src="https://img.shields.io/badge/Android-8.0%2B-green.svg" alt="Android 8.0+">
  <img src="https://img.shields.io/badge/Kotlin-2.1.0-blue.svg" alt="Kotlin">
  <img src="https://img.shields.io/badge/Compose-Material%203-purple.svg" alt="Jetpack Compose">
  <img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License">
</p>

Kotlin과 Jetpack Compose로 빌드된 네이티브 Android 클라이언트입니다. WebSocket을 통해 데스크톱 Clawd 앱에 연결하며, 플로팅 펫 오버레이가 SVG/APNG 애니메이션을 픽셀 단위 투명도로 렌더링하여 데스크톱 펫의 16가지 상태를 완벽하게 동기화합니다.

### 기능

- **QR 코드 페어링** — 데스크톱에 표시된 QR 코드를 스캔하면 즉시 연결 (`clawd://host:port/token`)
- **플로팅 펫 오버레이** — 시스템 수준 플로팅 윈도우, 16가지 애니메이션 상태를 데스크톱에서 실시간 동기화
- **3가지 캐릭터 테마** — Clawd(픽셀 크랩), Calico(삼색 고양이), Cloudling(운령)
- **알림 승인** — 휴대폰 알림 표시줄에서 AI 에이전트 권한 요청을 직접 승인 또는 거부
- **수면 시퀀스** — 하품 → 졸기 → 쓰러짐 → 수면 → 깜짝 깨기, 캐릭터별 독립 타이밍
- **제스처 컨트롤** — 드래그 이동, 탭 1회 정보 말풍선, 탭 2회 반응, 탭 3회 이스터에그
- **에지 스냅** — 펫이 화면 가장자리에 자동 부착, 재시작 후 위치 기억
- **딥 링크 지원** — `clawd://` URI 스킴으로 원활한 페어링
- **백그라운드 안정성** — 포그라운드 서비스 + WiFi 잠금 + 조건부 WakeLock + 자동 재연결 (지수 백오프 + 서킷 브레이커)
- **TOFU 인증서 검증** — Trust-On-First-Use 방식으로 LAN 연결 보안 보장
- **암호화 저장** — 연결 자격 증명을 AES-256-GCM으로 암호화 (EncryptedSharedPreferences)
- **다국어** — 영어, 중국어 간체, 중국어 번체, 한국어, 일본어

> 📖 **상세 문서**: [android/README.md](android/README.md) — 아키텍처, 상태 머신, 통신 프로토콜, 프로젝트 구조

### 빠른 시작 (Android)

1. **[GitHub Releases](https://github.com/Bynlk/clawd-on-mobile/releases/latest)**에서 최신 APK 다운로드
2. Android 8.0+ 기기에 설치
3. 데스크톱 Clawd를 열고 **설정 → 모바일 → QR 코드 표시**로 이동
4. 휴대폰으로 QR 코드를 스캔하면 연결 완료!

또는 수동으로 연결 정보(호스트, 포트, 토큰)를 입력할 수도 있습니다.

### 소스에서 빌드 (Android)

```bash
# 저장소 복제
git clone https://github.com/Bynlk/clawd-on-mobile.git
cd clawd-on-mobile/android

# 디버그 APK 빌드
./gradlew assembleDebug

# 릴리즈 APK 빌드
./gradlew assembleRelease
```

**요구 사항:** JDK 17, Android SDK (compileSdk 35), arm64-v8a 기기 또는 에뮬레이터

---

## 🖥️ 데스크톱 앱

데스크톱 Electron 앱은 실시간 상태 인식, 권한 말풍선, 커스텀 테마 등과 함께 **15개 이상의 AI 코딩 에이전트**를 지원합니다.

> **지원 에이전트:** Claude Code, Codex CLI, Copilot CLI, Gemini CLI, Antigravity CLI, Cursor Agent, CodeBuddy, Kiro CLI, Kimi Code CLI, Qwen Code, opencode, Pi, OpenClaw, Hermes Agent

> **플랫폼:** Windows 11, macOS, Ubuntu/Linux

전체 데스크톱 기능, 설정 가이드, 커스텀 테마 제작은 **[README-desk.ko-KR.md](README-desk.ko-KR.md)**를 참조하세요.

### 빠른 시작 (데스크톱)

**[GitHub Releases](https://github.com/Bynlk/clawd-on-mobile/releases/latest)**에서 최신 설치 파일을 다운로드하세요:

- **Windows**: `Clawd-on-Mobile-Setup-<version>-x64.exe` 또는 `-arm64.exe`
- **macOS**: `.dmg`
- **Linux**: `.AppImage` 또는 `.deb`

또는 소스에서 실행:

```bash
git clone https://github.com/Bynlk/clawd-on-mobile.git
cd clawd-on-mobile
npm install
npm start
```

---

## 아키텍처

```
┌─────────────────────┐       WebSocket (LAN)          ┌──────────────────────┐
│  데스크톱 Electron   │ ──────────────────────────────► │  Android 컴패니언    │
│  (Clawd on Desk)    │   Bearer 인증 + TOFU 인증서     │  (Kotlin)            │
│                     │                                 │                      │
│  15+ Agent Hooks    │  StateFlow<Map<SessionData>>    │  PetStateManager     │
│  권한 말풍선        │ ──────────────────────────────► │  (상태 결정 엔진)    │
│  세션 추적          │                                 │         │            │
│                     │  StateFlow<StateCommand>        │  FloatingPetService  │
│                     │ ──────────────────────────────► │  (뷰 쉘)             │
│                     │                                 │                      │
│                     │  PermissionRequestData          │                      │
│                     │ ◄────────────────────────────── │  Allow / Deny        │
└─────────────────────┘                                 └──────────────────────┘
```

- **브레인-셸 분리** — `PetStateManager`가 모든 상태 로직을 소유하고, `FloatingPetService`는 순수 뷰 컨슈머입니다
- **싱글 파이프 아키텍처** — 모든 상태 전이가 하나의 `StateFlow<StateCommand>`를 통해 흘러 경쟁 조건을 제거합니다
- **16가지 펫 상태** — Error > Notification > Sweeping > Attention > Conducting > Working > Thinking > Idle > Sleeping (데스크톱 우선순위와 정렬)

---

## 애니메이션

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>대기</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>생각</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>타이핑</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>건설</sub></td>
    <td align="center"><img src="assets/gif/clawd-headphones-groove.gif" width="100"><br><sub>헤드폰 그루브</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>저글링</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>Calico 대기</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>Calico 생각</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>Calico 타이핑</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>Calico 건설</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>Calico 저글링</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>Calico 지휘</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/cloudling-idle.gif" width="120"><br><sub>Cloudling 대기</sub></td>
    <td align="center"><img src="assets/gif/cloudling-thinking.gif" width="120"><br><sub>Cloudling 생각</sub></td>
    <td align="center"><img src="assets/gif/cloudling-typing.gif" width="120"><br><sub>Cloudling 타이핑</sub></td>
    <td align="center"><img src="assets/gif/cloudling-building.gif" width="120"><br><sub>Cloudling 건설</sub></td>
    <td align="center"><img src="assets/gif/cloudling-juggling.gif" width="120"><br><sub>Cloudling 저글링</sub></td>
    <td align="center"><img src="assets/gif/cloudling-conducting.gif" width="120"><br><sub>Cloudling 지휘</sub></td>
  </tr>
</table>

---

## 기여하기

Clawd on Mobile은 커뮤니티 주도 프로젝트입니다. 버그 리포트, 기능 아이디어, PR 모두 환영합니다. [issue](https://github.com/Bynlk/clawd-on-mobile/issues)를 열어 논의하거나 바로 PR을 보내 주세요.

### 원본 프로젝트

[Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desktop)의 Fork이며, 원작자 [@rullerzhou-afk](https://github.com/rullerzhou-afk). 모든 데스크톱 기능이 보존되어 있으며, [@Bynlk](https://github.com/Bynlk)이 Android 컴패니언 앱을 추가했습니다.

### 메인테이너 (데스크톱)

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · 제작자</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />메인테이너</sub></a></td>
  </tr>
</table>

### Android 컴패니언 메인테이너

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="72" style="border-radius:50%" /><br /><sub><b>@Bynlk</b><br />Android 개발</sub></a></td>
  </tr>
</table>

### 기여자

Clawd를 더 좋게 만드는 데 도움을 준 모든 분들께 감사합니다:

<table>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /><br /><sub>PixelCookie-zyf</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /><br /><sub>yujiachen-y</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /><br /><sub>AooooooZzzz</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /><br /><sub>purefkh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /><br /><sub>Tobeabellwether</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /><br /><sub>Jasonhonghh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /><br /><sub>crashchen</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /><br /><sub>hongbigtou</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /><br /><sub>InTimmyDate</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /><br /><sub>NeizhiTouhu</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /><br /><sub>xu3stones-cmd</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /><br /><sub>androidZzT</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /><br /><sub>Ye-0413</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /><br /><sub>WanfengzzZ</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /><br /><sub>TaoXieSZ</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /><br /><sub>ssly</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /><br /><sub>stickycandy</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /><br /><sub>Rladmsrl</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /><br /><sub>YOIMIYA66</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /><br /><sub>Kevin7Qi</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sefuzhou770801-hub"><img src="https://github.com/sefuzhou770801-hub.png" width="50" style="border-radius:50%" /><br /><sub>sefuzhou770801-hub</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tonic-Jin"><img src="https://github.com/Tonic-Jin.png" width="50" style="border-radius:50%" /><br /><sub>Tonic-Jin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/seoki180"><img src="https://github.com/seoki180.png" width="50" style="border-radius:50%" /><br /><sub>seoki180</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sophie-haynes"><img src="https://github.com/sophie-haynes.png" width="50" style="border-radius:50%" /><br /><sub>sophie-haynes</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/PeterShanxin"><img src="https://github.com/PeterShanxin.png" width="50" style="border-radius:50%" /><br /><sub>PeterShanxin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/CHIANGANGSTER"><img src="https://github.com/CHIANGANGSTER.png" width="50" style="border-radius:50%" /><br /><sub>CHIANGANGSTER</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/JaeHyeon-KAIST"><img src="https://github.com/JaeHyeon-KAIST.png" width="50" style="border-radius:50%" /><br /><sub>JaeHyeon-KAIST</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/hhhzxyhhh"><img src="https://github.com/hhhzxyhhh.png" width="50" style="border-radius:50%" /><br /><sub>hhhzxyhhh</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TVpoet"><img src="https://github.com/TVpoet.png" width="50" style="border-radius:50%" /><br /><sub>TVpoet</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/zeus6768"><img src="https://github.com/zeus6768.png" width="50" style="border-radius:50%" /><br /><sub>zeus6768</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/anhtrinh919"><img src="https://github.com/anhtrinh919.png" width="50" style="border-radius:50%" /><br /><sub>anhtrinh919</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tomaioo"><img src="https://github.com/tomaioo.png" width="50" style="border-radius:50%" /><br /><sub>tomaioo</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/v-avuso"><img src="https://github.com/v-avuso.png" width="50" style="border-radius:50%" /><br /><sub>v-avuso</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/livlign"><img src="https://github.com/livlign.png" width="50" style="border-radius:50%" /><br /><sub>livlign</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tongguang2"><img src="https://github.com/tongguang2.png" width="50" style="border-radius:50%" /><br /><sub>tongguang2</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/Ziy1-Tan"><img src="https://github.com/Ziy1-Tan.png" width="50" style="border-radius:50%" /><br /><sub>Ziy1-Tan</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tatsuyanakanogaroinc"><img src="https://github.com/tatsuyanakanogaroinc.png" width="50" style="border-radius:50%" /><br /><sub>tatsuyanakanogaroinc</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/yeonhub"><img src="https://github.com/yeonhub.png" width="50" style="border-radius:50%" /><br /><sub>yeonhub</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/joshua-wu"><img src="https://github.com/joshua-wu.png" width="50" style="border-radius:50%" /><br /><sub>joshua-wu</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/nmsn"><img src="https://github.com/nmsn.png" width="50" style="border-radius:50%" /><br /><sub>nmsn</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sunnysonx"><img src="https://github.com/sunnysonx.png" width="50" style="border-radius:50%" /><br /><sub>sunnysonx</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/YuChenYunn"><img src="https://github.com/YuChenYunn.png" width="50" style="border-radius:50%" /><br /><sub>YuChenYunn</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/jhseo-b"><img src="https://github.com/jhseo-b.png" width="50" style="border-radius:50%" /><br /><sub>jhseo-b</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Hwasowl"><img src="https://github.com/Hwasowl.png" width="50" style="border-radius:50%" /><br /><sub>Hwasowl</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/XiangZheng2002"><img src="https://github.com/XiangZheng2002.png" width="50" style="border-radius:50%" /><br /><sub>XiangZheng2002</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/keiyo118"><img src="https://github.com/keiyo118.png" width="50" style="border-radius:50%" /><br /><sub>keiyo118</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/pan93412"><img src="https://github.com/pan93412.png" width="50" style="border-radius:50%" /><br /><sub>pan93412</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/taehwanis"><img src="https://github.com/taehwanis.png" width="50" style="border-radius:50%" /><br /><sub>taehwanis</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/linnin233"><img src="https://github.com/linnin233.png" width="50" style="border-radius:50%" /><br /><sub>linnin233</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/xiyouMc"><img src="https://github.com/xiyouMc.png" width="50" style="border-radius:50%" /><br /><sub>xiyouMc</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="50" style="border-radius:50%" /><br /><sub>Bynlk</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/zxypro1"><img src="https://github.com/zxypro1.png" width="50" style="border-radius:50%" /><br /><sub>zxypro1</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/NeroAyase"><img src="https://github.com/NeroAyase.png" width="50" style="border-radius:50%" /><br /><sub>NeroAyase</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/divergentD"><img src="https://github.com/divergentD.png" width="50" style="border-radius:50%" /><br /><sub>divergentD</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Ne9roni"><img src="https://github.com/Ne9roni.png" width="50" style="border-radius:50%" /><br /><sub>Ne9roni</sub></a></td>
  </tr>
</table>

## 감사의 말

- Clawd 픽셀 아트 참고: [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- [LINUX DO](https://linux.do/) 커뮤니티에서 공유됨

## 라이선스

소스 코드는 [GNU Affero General Public License v3.0](LICENSE)(AGPL-3.0)로 배포됩니다.

**아트워크와 번들 테마 에셋(`assets/` 및 `themes/*/assets/` 포함)은 AGPL-3.0 라이선스 대상이 아닙니다.** 각 저작권자의 권리가 유지되며 자세한 내용은 [assets/LICENSE](assets/LICENSE)와 아래 고지를 참고하세요.

- **Clawd** 캐릭터는 [Anthropic](https://www.anthropic.com)의 자산입니다. 이 프로젝트는 비공식 팬 프로젝트이며 Anthropic과 제휴하거나 승인받지 않았습니다.
- **Calico cat (삼색 고양이)** 아트워크는 鹿鹿([@rullerzhou-afk](https://github.com/rullerzhou-afk))의 작품이며, 모든 권리를 보유합니다.
- **Cloudling (云宝)** 아트워크는 鹿鹿([@rullerzhou-afk](https://github.com/rullerzhou-afk))의 작품이며, 모든 권리를 보유합니다. Cloudling의 시각 방향에는 OpenAI Codex 로고에 대한 오마주가 포함되어 있습니다. Codex/OpenAI 관련 표장은 OpenAI의 자산이며, 이 프로젝트는 OpenAI와 제휴하거나 승인받지 않았습니다.
- **서드파티 기여물**: 저작권은 각 아티스트에게 유지됩니다.
