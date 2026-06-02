# P3-1: Network Security Config 精细化

> **优先级**: P3 — 安全加固  
> **影响范围**: `AndroidManifest.xml`, `res/xml/network_security_config.xml`  
> **预估工时**: 30min  
> **启动提示词**: `执行 P3-1: 精细化 network_security_config，移除 manifest 级 usesCleartextTraffic，仅对 LAN 地址段放行明文流量`

---

## 问题描述

```xml
<!-- AndroidManifest.xml:23 -->
android:usesCleartextTraffic="true"
```

全局允许明文 HTTP 流量。虽然 `network_security_config.xml` 可能有更细粒度的控制，但 manifest 级设置优先级低，且向所有域名开放了明文流量权限。

## 修复方案

### Step 1: 移除 manifest 级设置

```xml
<!-- AndroidManifest.xml -->
<application
    android:name=".ClawdApp"
    android:allowBackup="false"
    android:icon="@mipmap/ic_launcher"
    android:label="@string/app_name"
    android:supportsRtl="true"
    <!-- 移除: android:usesCleartextTraffic="true" -->
    android:networkSecurityConfig="@xml/network_security_config"
    android:theme="@style/Theme.ClawdMobile">
```

### Step 2: 配置 network_security_config

```xml
<!-- res/xml/network_security_config.xml -->
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- 允许 localhost 明文（开发/本地连接） -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">127.0.0.1</domain>
        <domain includeSubdomains="true">[::1]</domain>
    </domain-config>

    <!-- 允许 LAN 地址段明文 -->
    <!-- 10.0.0.0/8 -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">10.*</domain>
    </domain-config>

    <!-- 172.16.0.0/12 — Android domain-config 不支持 CIDR，需逐个配置或使用 base-config -->
    <!-- 192.168.0.0/16 -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">192.168.*</domain>
    </domain-config>

    <!-- mDNS .local -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">local</domain>
    </domain-config>

    <!-- 默认：强制 TLS -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

### 注意事项

Android `network-security-config` 的 `domain` 匹配不支持 CIDR 表示法，只能用通配符。对于 `172.16.0.0/12` 段，无法精确匹配。两种处理方式：

1. **接受不精确**: 仅配置 `10.*` 和 `192.168.*`，覆盖最常见的 LAN 场景
2. **保留 manifest 级**: 如果需要支持所有 LAN 段，保留 `usesCleartextTraffic="true"` 但添加注释说明原因

**推荐方案 1**，因为 `172.16.x.x` 段在家庭/小型办公网络中极少使用。

## 验收标准

- [ ] `AndroidManifest.xml` 中移除 `android:usesCleartextTraffic="true"`
- [ ] `network_security_config.xml` 配置了 LAN 地址段明文放行
- [ ] 非 LAN 连接强制 TLS
- [ ] SSE 连接到 LAN 服务器正常工作
- [ ] SSE 连接到远程服务器使用 HTTPS
