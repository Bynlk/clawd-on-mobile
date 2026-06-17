"use strict";

// Mobile companion i18n strings — merged into ClawdSettingsI18n.STRINGS at load time.
// This file must be loaded AFTER settings-i18n.js.
(function initMobileI18n() {
  const MOBILE_STRINGS = {
    en: {
      sidebarMobile: "Mobile",
      mobileTitle: "Mobile",
      mobileDesc: "Connect your phone to monitor sessions and approve permissions remotely.",
      mobileQrTitle: "Android: Scan to Connect",
      mobilePwaToggle: "PWA Web Version",
      mobilePwaToggleDesc: "For iPhone or non-Android devices — open in a browser.",
      mobileConnInfo: "Connection Info",
      mobileDevices: "Connected Devices",
      mobileLoading: "Loading…",
      mobileError: "Unable to load connection info.",
      rowMobileCompanion: "Mobile companion",
      rowMobileCompanionDesc: "Enable the mobile WebSocket server for Android/PWA connections. Requires restart.",
      relayTitle: "Remote Relay",
      relayDesc: "Connect via a remote relay server for non-LAN environments.",
      relayUrl: "Relay URL",
      relayToken: "Admin Token",
      relayEnable: "Connect Relay",
      relayDisable: "Disconnect Relay",
      relayCheckStatus: "Check Relay Status",
      relayStatusConnected: "Enabled",
      relayStatusDisconnected: "Disconnected",
    },
    zh: {
      sidebarMobile: "移动端",
      mobileTitle: "移动端",
      mobileDesc: "连接手机监控会话状态，支持远程审批。",
      mobileQrTitle: "Android 扫码连接",
      mobilePwaToggle: "PWA 网页版",
      mobilePwaToggleDesc: "iPhone 或非 Android 设备可在浏览器中打开。",
      mobileConnInfo: "连接信息",
      mobileDevices: "已连接设备",
      mobileLoading: "加载中…",
      mobileError: "无法加载连接信息。",
      rowMobileCompanion: "移动端伴侣",
      rowMobileCompanionDesc: "启用移动端 WebSocket 服务器以支持 Android/PWA 连接。需要重启。",
      relayTitle: "远程中继",
      relayDesc: "通过远程服务器中继连接，支持非局域网环境。",
      relayUrl: "Relay 地址",
      relayToken: "管理 Token",
      relayEnable: "连接 Relay",
      relayDisable: "断开 Relay",
      relayCheckStatus: "检查 Relay 状态",
      relayStatusConnected: "已启用",
      relayStatusDisconnected: "未连接",
    },
    "zh-TW": {
      sidebarMobile: "行動端",
      mobileTitle: "行動端",
      mobileDesc: "連接手機監控工作階段狀態，支援遠端核准。",
      mobileQrTitle: "Android 掃碼連線",
      mobilePwaToggle: "PWA 網頁版",
      mobilePwaToggleDesc: "iPhone 或非 Android 裝置可在瀏覽器中開啟。",
      mobileConnInfo: "連線資訊",
      mobileDevices: "已連線裝置",
      mobileLoading: "載入中…",
      mobileError: "無法載入連線資訊。",
      rowMobileCompanion: "行動端伴侶",
      rowMobileCompanionDesc: "啟用行動端 WebSocket 伺服器以支援 Android/PWA 連線。需要重新啟動。",
    },
    ko: {
      sidebarMobile: "모바일",
      mobileTitle: "모바일",
      mobileDesc: "휴대폰을 연결하여 세션을 모니터링하고 원격으로 승인합니다.",
      mobileQrTitle: "Android: 스캔하여 연결",
      mobilePwaToggle: "PWA 웹 버전",
      mobilePwaToggleDesc: "iPhone 또는 비Android 기기 — 브라우저에서 열기.",
      mobileConnInfo: "연결 정보",
      mobileDevices: "연결된 기기",
      mobileLoading: "로딩 중…",
      mobileError: "연결 정보를 불러올 수 없습니다.",
      rowMobileCompanion: "모바일 컴패니언",
      rowMobileCompanionDesc: "Android/PWA 연결을 위한 모바일 WebSocket 서버를 활성화합니다. 재시작 필요.",
    },
    ja: {
      sidebarMobile: "モバイル",
      mobileTitle: "モバイル",
      mobileDesc: "スマートフォンを接続してセッションを監視し、リモートで承認します。",
      mobileQrTitle: "Android: スキャンして接続",
      mobilePwaToggle: "PWA Web版",
      mobilePwaToggleDesc: "iPhoneまたは非Androidデバイス — ブラウザで開く。",
      mobileConnInfo: "接続情報",
      mobileDevices: "接続デバイス",
      mobileLoading: "読み込み中…",
      mobileError: "接続情報を読み込めません。",
      rowMobileCompanion: "モバイルコンパニオン",
      rowMobileCompanionDesc: "Android/PWA接続用のモバイルWebSocketサーバーを有効にします。再起動が必要です。",
    },
  };

  // Merge into the global STRINGS object if available
  if (globalThis.ClawdSettingsI18n && globalThis.ClawdSettingsI18n.STRINGS) {
    const STRINGS = globalThis.ClawdSettingsI18n.STRINGS;
    for (const [lang, strings] of Object.entries(MOBILE_STRINGS)) {
      if (!STRINGS[lang]) STRINGS[lang] = {};
      Object.assign(STRINGS[lang], strings);
    }
  }
})();
