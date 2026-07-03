<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd Mobile">
</p>

<h1 align="center">Clawd Mobile</h1>
<p align="center">
  <strong><a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a>의 Android 컴패니언 앱 — AI 코딩 에이전트에 실시간으로 반응하는 사이버펑크 데스크톱 펫.</strong>
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">简体中文</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
  ·
  <a href="README-desk.md">Desktop Version</a>
</p>

<p align="center">
  <a href="https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml"><img src="https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml/badge.svg" alt="Android Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License"></a>
  <a href="https://github.com/Bynlk/clawd-on-mobile/releases"><img src="https://img.shields.io/github/v/release/Bynlk/clawd-on-mobile" alt="Version"></a>
  <img src="https://img.shields.io/badge/Android-8.0%2B-green.svg" alt="Android 8.0+">
  <img src="https://img.shields.io/badge/API-26%2B-brightgreen.svg" alt="API 26+">
</p>

<p align="center">
  <img src="assets/hero-mobile.gif" alt="Clawd Mobile 홈 화면. 픽셀아트 펫이 AI 코딩 에이전트에 실시간으로 반응합니다. 왼쪽부터 오른쪽으로 4가지 세션 상태 표시: 생각 중 Thinking, 작업 중 Working, 승인 대기 Approval, 완료를 축하하는 Done.">
</p>

<p align="center">
  <sub>펫이 실시간으로 반응 — <b>Thinking</b> · <b>Working</b> · <b>Approval</b> · <b>Done</b></sub>
</p>

---

> **🙏 원작자에게 경의를**
>
> 이 프로젝트는 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)(Clawd on Desk) 데스크톱 버전을 기반으로 개발되었습니다. 원본은 [@rullerzhou-afk](https://github.com/rullerzhou-afk)(鹿鹿 / Ruller_Lulu)가 만든, 당신의 데스크톱에 살며 AI 코딩 에이전트의 모든 움직임을 감지하는 작은 게입니다.
>
> Android 버전은 커뮤니티 개발자 [@Bynlk](https://github.com/Bynlk)가 포팅하고 유지 관리합니다. 프로젝트에 기여해 주신 모든 [개발자](#-기여자) 여러분께 감사드립니다.

---

## 📖 목차

- [Clawd Mobile이란?](#-clawd-mobile이란)
- [기능](#-기능)
- [스크린샷](#-스크린샷)
- [빠른 시작](#-빠른-시작)
- [아키텍처](#-아키텍처)
- [통신 프로토콜](#-통신-프로토콜)
- [개발](#-개발)
- [기여하기](#-기여하기)
- [향후 기능](#-향후-기능)
- [로드맵](#-로드맵)
- [FAQ](#-faq)
- [기여자](#-기여자)
- [라이선스](#-라이선스)
- [감사의 말](#-감사의-말)

---

## 🐾 Clawd Mobile이란?

**Clawd Mobile**은 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 데스크톱 펫에 연결하는 네이티브 Android 클라이언트입니다. **LAN 또는 원격 릴레이**를 통해 AI 코딩 에이전트의 활동을 실시간으로 모니터링하고, 에이전트의 동작에 반응하는 애니메이션 펫을 휴대폰 화면에 표시합니다.

| 특징 | 작동 방식 | 경험 |
|------|----------|------|
| **밀리초 단위 상태 동기화** | WebSocket + `StateFlow` 파이프라인, 지연 < 200ms | 에이전트가 입력하는 순간 게도 입력을 시작 |
| **순수 캐릭터 격리** | 서버 측 `displayState` + `PetStateManager` 엔진 | 3개 캐릭터(게/삼색묘/구름)의 독립적 상태 매핑 |
| **초저전력** | `WifiLock` + `WakeLock` + 30초 워치독 + 지수 백오프(1s→30s) | 백그라운드 전력 < 50mW, 하루 종일 유지 |
| **오버레이 승인** | 플로팅 버블에서 스와이프로 권한 요청 승인 | 앱을 열 필요 없음 |
| **원격 릴레이** | VPS 릴레이를 통해 비 LAN 환경에서도 연결 | 어디서나 에이전트 모니터링 |

---

## ✨ 기능

### 핵심 경험
- 🐾 **애니메이션 플로팅 펫** — SVG/APNG + CSS 애니메이션(호흡, 깜빡임, 꼬리 흔들기)
- 📱 **16가지 상태** — Working, Thinking, Idle, Sleeping, Error, Notification 등
- 🎯 **스마트 수면 시퀀스** — Yawning → Dozing → Collapsing → Sleeping + 랜덤 idle 변형
- 🏆 **축하 애니메이션** — 작업 완료 시 1.5초 애니메이션 재생

### v0.10.0 — 최신 릴리스
- 🐾 **오버레이 승인 버블** — 플로팅 버블에서 스와이프로 권한 요청 승인/거부
- 🌐 **원격 릴레이** — VPS 릴레이 서버를 통해 비 LAN 환경 지원
- 🌍 **앱 내 언어 전환** — 중국어/영어를 재시작 없이 전환
- 🔒 **보안 강화** — 암호화 저장소, TOFU 인증서 피닝, 로그 제거
- 🧪 **548개 테스트** — 전부 통과, 103개 신규 테스트 추가

---

## 📸 스크린샷

> _스크린샷 준비 중. 앱은 휴대폰 화면에 애니메이션 펫을 표시하며 AI 에이전트의 활동——생각 중, 작업 중, 승인 대기, 작업 완료 축하——에 실시간으로 반응합니다._

| 플로팅 펫 | 승인 버블 | 설정 |
|:---:|:---:|:---:|
| _스크린샷_ | _스크린샷_ | _스크린샷_ |

---

## ⚡ 빠른 시작

### 사전 요구사항
- Android 8.0+ (API 26), arm64-v8a 지원 기기
- PC에서 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 실행 중

### 설치

1. [Releases](https://github.com/Bynlk/clawd-on-mobile/releases)에서 최신 `app-release.apk` 다운로드
2. Android 기기에 APK 설치
3. 앱을 열고 PC에 표시된 QR 코드를 스캔하거나 연결 정보를 수동 입력
4. 요청된 권한(알림, 카메라, 오버레이) 허용
5. 펫이 실행되었습니다! 🎉

### 연결 방법

| 방법 | 사용 시점 |
|------|---------|
| **QR 코드 스캔** | PC와 휴대폰이 같은 LAN — 가장 빠름 |
| **수동 입력** | PC의 IP, 포트, 토큰을 수동 입력 |
| **원격 릴레이** | VPS 릴레이를 통해 비 LAN 환경에 연결 |

---

## 🏛️ 아키텍처

Clawd Mobile은 모든 상태 변경이 하나의 통합된 `StateFlow`를 통해 흐르는 **단일 파이프 아키텍처**를 채택합니다:

```
PC (WebSocket) → StreamingClient → PetStateManager → FloatingPetService
                                          ↓
                                    StateCommand (단일 파이프)
                                          ↓
                              SvgLoader → FloatingPetView (WebView SVG)
```

**핵심 설계 결정:**
- **단일 파이프** — 동시 SVG 로딩 경합 제거
- **템플릿 메서드 패턴**(`StreamingClient` → `AbstractStreamingClient` → `WsClient`) — 전송 계층 확장이 용이
- **전략 패턴**(`ConnectionStrategy`) — LAN/Relay 연결 디커플링
- **SessionMerger** — LAN + Relay 세션을 하나의 뷰로 통합

자세한 아키텍처 문서는 [android/README.md](android/README.md)를 참조하세요.

---

## 📡 통신 프로토콜

```
WebSocket:  ws://<host>:23334/mobile/ws
승인:       POST http://<host>:23334/mobile/approve
Deep Link:  clawd://<host>:<port>/<token>
```

| 메시지 타입 | 방향 | 설명 |
|-------------|------|------|
| `ping` | 서버 → 클라이언트 | 하트비트 |
| `connected` | 서버 → 클라이언트 | 연결 확인 |
| `snapshot` | 서버 → 클라이언트 | 전체 세션 목록 |
| `state` | 서버 → 클라이언트 | 단일 세션 업데이트 |
| `permission_request` | 서버 → 클라이언트 | 승인 요청 |
| `reaction` | 서버 → 클라이언트 | SVG 반응 애니메이션 |

---

## 🔧 개발

### 환경
- Android Studio Hedgehog (2023.1.1)+
- JDK 17
- Android SDK 35
- arm64-v8a 기기 또는 에뮬레이터

### 빌드

```bash
cd android

# Debug APK
./gradlew assembleDebug

# Release APK(서명 설정 필요)
KEYSTORE_FILE=release.keystore \
STORE_PASSWORD=xxx \
KEY_ALIAS=clawd \
KEY_PASSWORD=xxx \
./gradlew assembleRelease

# 테스트 실행(548개 테스트)
./gradlew testDebugUnitTest
```

### CI/CD

`android/` 변경 사항을 포함하여 `main`에 push하면 GitHub Actions가 실행됩니다: lint → build → test → artifact 업로드.

---

## 🤝 기여하기
Clawd on Mobile은 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)를 기반으로 한 2차 창작 프로젝트로, 데스크톱 버전에 Android 컴패니언 앱, 오버레이 승인, 원격 릴레이 등의 기능을 추가했습니다.

이 프로젝트에 기여하려면 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참조하세요.

버그 리포트, 기능 제안, 풀 리퀘스트를 모두 환영합니다 — [issue](https://github.com/Bynlk/clawd-on-mobile/issues)를 열어 논의하거나 직접 PR을 보내주세요.

### 메인테이너

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · creator</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />maintainer</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="72" style="border-radius:50%" /><br /><sub><b>@Bynlk</b><br />core contributor · Mobile / PWA</sub></a></td>
  </tr>
</table>

### 기여자

Clawd를 더 좋게 만들어 준 모든 분께 감사드립니다:

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
    <td align="center" valign="top" width="110"><a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /><br /><sub>Ye-0413</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /><br /><sub>WanfengzzZ</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /><br /><sub>androidZzT</sub></a></td>
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
    <td align="center" valign="top" width="110"><a href="https://github.com/QingXB"><img src="https://github.com/QingXB.png" width="50" style="border-radius:50%" /><br /><sub>QingXB</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/29206394"><img src="https://github.com/29206394.png" width="50" style="border-radius:50%" /><br /><sub>29206394</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tsdsj"><img src="https://github.com/Tsdsj.png" width="50" style="border-radius:50%" /><br /><sub>Tsdsj</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/godlockin"><img src="https://github.com/godlockin.png" width="50" style="border-radius:50%" /><br /><sub>godlockin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sLingli"><img src="https://github.com/sLingli.png" width="50" style="border-radius:50%" /><br /><sub>sLingli</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/ustin-star"><img src="https://github.com/ustin-star.png" width="50" style="border-radius:50%" /><br /><sub>ustin-star</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/cod3hulk"><img src="https://github.com/cod3hulk.png" width="50" style="border-radius:50%" /><br /><sub>cod3hulk</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/lxgxhsy"><img src="https://github.com/lxgxhsy.png" width="50" style="border-radius:50%" /><br /><sub>lxgxhsy</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/rebootcrab-blip"><img src="https://github.com/rebootcrab-blip.png" width="50" style="border-radius:50%" /><br /><sub>rebootcrab-blip</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/zhaoxv210"><img src="https://github.com/zhaoxv210.png" width="50" style="border-radius:50%" /><br /><sub>zhaoxv210</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/serenNan"><img src="https://github.com/serenNan.png" width="50" style="border-radius:50%" /><br /><sub>serenNan</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/IatomicreactorI"><img src="https://github.com/IatomicreactorI.png" width="50" style="border-radius:50%" /><br /><sub>IatomicreactorI</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/quantai1314"><img src="https://github.com/quantai1314.png" width="50" style="border-radius:50%" /><br /><sub>quantai1314</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Git-creat7"><img src="https://github.com/Git-creat7.png" width="50" style="border-radius:50%" /><br /><sub>Git-creat7</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/undownding"><img src="https://github.com/undownding.png" width="50" style="border-radius:50%" /><br /><sub>undownding</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/chrono-meta"><img src="https://github.com/chrono-meta.png" width="50" style="border-radius:50%" /><br /><sub>chrono-meta</sub></a></td>
  </tr>
</table>

기여를 시작하는 방법:

1. 저장소를 **Fork**
2. 기능 브랜치 **생성**: `git checkout -b feat/my-feature`
3. 명확한 메시지로 **커밋**: `git commit -m "feat: add my feature"`
4. 당신의 fork로 **Push**: `git push origin feat/my-feature`
5. Pull Request **열기**

### 가이드라인
- Kotlin 코딩 규칙 준수
- 새 기능에는 테스트 추가
- 필요 시 문서 업데이트
- PR 설명에 관련 Issue 참조

자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

---

## 🔮 향후 기능

Clawd Mobile은 이미 LAN 또는 자체 호스팅 릴레이를 통해 에이전트를 관찰하고 권한을 승인할 수 있습니다. 다음으로 두 가지 더 큰 기능이 준비 중이며, 목표는 동일합니다: **책상을 떠나 있어도 에이전트를 계속 제어한다.**

### 1. 🌐 호스팅형 서버 릴레이(외출 중에도 승인)

현재 릴레이는 VPS에 직접 배포해야 합니다. 다음 단계는 **설정이 필요 없는 상시 가동 릴레이**를 제공하여, 다른 Wi-Fi, 셀룰러 데이터, 이동 중에도 휴대폰이 데스크톱 에이전트와의 연결을 유지하도록 하는 것입니다. 외출 중 에이전트가 권한 요청에 도달하면 승인 버블이 휴대폰에 도착하고, 같은 Wi-Fi에 있지 않아도, 서버를 수동으로 구축하지 않아도 **어디서나 Allow / Deny** 할 수 있습니다.

- 셀룰러를 통해 어디서나 권한 요청 승인/거부
- 제로 설정 연결 —— 자체 VPS 불필요
- 기존 TOFU 인증서 피닝 기반 위에 엔드투엔드 보안

### 2. 📬 콘텐츠 푸시(터미널 표시를 1:1 동기화)

애니메이션 상태를 넘어, 휴대폰이 **터미널이 실제로 표시하는 내용을 1:1로 미러링**하도록 하고자 합니다. 이를 통해 펫의 기분으로 추측하는 대신 에이전트가 무엇을 하는지 직접 읽을 수 있습니다. 정확한 범위, 전달 형식, 프라이버시 모델은 **아직 논의 중**이며, 설계가 확정되면 이 섹션을 채우겠습니다.

> 💡 두 기능에 대한 의견이 있으신가요? [issue](https://github.com/Bynlk/clawd-on-mobile/issues) 또는 [discussion](https://github.com/Bynlk/clawd-on-mobile/discussions)을 열어 주세요 —— 형태를 갖춰가는 동안의 피드백은 매우 소중합니다.

---

## 🗺️ 로드맵

| 우선순위 | 항목 | 상태 |
|--------|------|------|
| ✅ | WebSocket 마이그레이션(SSE에서) | 완료 |
| ✅ | TOFU 인증서 피닝 | 완료 |
| ✅ | 오버레이 승인 버블 | 완료 |
| ✅ | 원격 릴레이 지원 | 완료 |
| ✅ | 앱 내 언어 전환 | 완료 |
| ✅ | 보안 강화 | 완료 |
| 🔄 | Hilt 의존성 주입 | 계획됨 |
| 🔄 | Repository 패턴 | 계획됨 |
| 🔄 | AbstractStreamingClient 테스트 | 계획됨 |
| 🔮 | 호스팅형 서버 릴레이(어디서나 승인) | 탐색 중 |
| 🔮 | 콘텐츠 푸시(1:1 터미널 미러) | 논의 중 |

전체 로드맵은 [android/docs/ROADMAP.md](android/docs/ROADMAP.md)를 참조하세요.

---

## ❓ FAQ

**Q: 데스크톱 앱이 필요한가요?**
A: 네. Clawd Mobile은 컴패니언 앱으로, PC에서 실행되는 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)에 연결합니다.

**Q: 홈 네트워크 밖에서도 사용할 수 있나요?**
A: 네! v0.10.0에서 원격 릴레이 지원을 추가했습니다. VPS에 릴레이 서버를 배포하면 어디서나 연결할 수 있습니다.

**Q: 어떤 AI 에이전트를 지원하나요?**
A: Clawd on Desk와 호환되는 모든 에이전트 — Claude Code, Codex, Cursor, Copilot, Gemini 등.

**Q: 펫이 움직이지 않음 / idle 상태 유지**
A: 데스크톱 앱이 연결되어 있고 활성 세션이 있는지 확인하세요. 앱 설정에서 연결 상태를 확인합니다.

**Q: 어떻게 업데이트하나요?**
A: [Releases](https://github.com/Bynlk/clawd-on-mobile/releases)에서 최신 APK를 다운로드하여 기존 앱 위에 덮어 설치하세요. 데이터는 유지됩니다.

---

## 👥 기여자

### Android 포팅
- [@Bynlk](https://github.com/Bynlk) — Android 포팅 개발자 & 메인테이너

### 데스크톱 기여자
다음 개발자들이 Clawd 생태계(데스크톱 + 모바일)에 기여했습니다:

| 기여자 | 기여 내용 |
|--------|---------|
| [@rullerzhou-afk](https://github.com/rullerzhou-afk) (鹿鹿) | Clawd on Desk 원작자 |
| [@Ruller_Lulu](https://github.com/Ruller_Lulu) | 코어 개발 |
| [@Yoimiya](https://github.com/Yoimiya) | 주요 기여 |
| [@Lyu Bingrong](https://github.com/LyuBingrong) | 기능 및 수정 |
| [@hwasowl](https://github.com/hwasowl) | 기능 및 수정 |
| [@nmsn](https://github.com/nmsn) | 기능 및 수정 |
| [@zxypro](https://github.com/zxypro) | Telegram 승인 상태 |
| [@sLingli](https://github.com/sLingli) | Reasonix CLI 통합 |
| [@cod3hulk](https://github.com/cod3hulk) | tmux 포커스 지원 |
| [@lxgxhsy](https://github.com/lxgxhsy) | Windows 포커스 캐시 |
| [@rebootcrab-blip](https://github.com/rebootcrab-blip) | Agent asar 패키징 수정 |
| [@ustin-star](https://github.com/ustin-star) | CodeWhale 어댑터 |

> 🙏 **Clawd 프로젝트에 기여해 주신 모든 개발자분께 감사드립니다!** 코드, 문서, 버그 리포트, 기능 제안 무엇이든 모든 기여가 이 프로젝트를 더 좋게 만듭니다.
>
> 기여했는데 이름이 목록에 없다면 Issue 또는 PR을 열어 직접 추가해 주세요.

---

## 📄 라이선스

- **코드**: [AGPL-3.0](LICENSE)
- **아트 에셋**: All Rights Reserved

**Clawd**는 [Anthropic](https://www.anthropic.com)이 소유한 캐릭터입니다. 이것은 비공식 팬 프로젝트이며 Anthropic과 관련이 없고 승인받지 않았습니다.

---

## 🙏 감사의 말

- **[rullerzhou-afk](https://github.com/rullerzhou-afk)**(鹿鹿 / Ruller_Lulu) — 모든 것의 시작인 데스크톱 펫 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)의 제작자. 이 멋진 프로젝트를 만들고 오픈소스로 공개해 주셔서 감사합니다.

- **[Anthropic](https://www.anthropic.com)** — 이 프로젝트에 영감을 준 Claude를 만들어 주셔서.

- **모든 [기여자](#-기여자)** — 여러분의 시간, 코드, 열정에 감사드립니다.

- **오픈소스 커뮤니티** — 이를 가능하게 한 도구와 라이브러리에: Kotlin, Jetpack Compose, OkHttp, kotlinx.serialization, CameraX, ZXing 등.

---

<p align="center">
  <sub>⭐ 이 프로젝트가 마음에 든다면 <a href="https://github.com/Bynlk/clawd-on-mobile">GitHub</a>에서 스타를 눌러주세요!</sub>
</p>
