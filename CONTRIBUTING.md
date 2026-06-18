# 贡献指南

感谢你对 Clawd on Mobile 项目的关注！

## 开发环境

### 前置要求

- Node.js >= 18
- Android Studio (Android 开发)
- Git

### 桌面端

```bash
npm install
npm start          # 启动开发模式
npm test           # 运行测试
npm run build      # 构建
```

### Android 端

```bash
cd android
./gradlew assembleDebug      # 构建 Debug APK
./gradlew testDebugUnitTest  # 运行单元测试
```

## 分支规范

- `main` — 稳定版本
- `feat/<功能名>` — 新功能开发
- `fix/<问题名>` — Bug 修复
- `refactor/<范围>` — 重构

## Commit 规范

使用中文，简明扼要：

```
动作：简短描述
```

常用动作前缀：
- `新增：` — 新功能、新文件
- `删除：` — 移除功能、文件
- `修复：` — Bug 修复
- `重构：` — 代码重构
- `更新：` — 更新文档、配置
- `优化：` — 性能优化
- `配置：` — CI/CD、构建配置

示例：
```
新增：浮窗内审批气泡
修复：sseClient 命名残留
重构：提取 mobile 集成模块
```

## PR 流程

1. Fork 仓库
2. 创建功能分支 (`feat/xxx`)
3. 提交改动（遵循 commit 规范）
4. 运行测试确保通过 (`npm test` / `./gradlew testDebugUnitTest`)
5. 创建 Pull Request
6. 等待 CI 通过 + Code Review

## Issue 规范

- 使用清晰的标题描述问题
- 提供复现步骤（Bug 报告）
- 提供环境信息（OS、Node 版本等）

## 代码规范

- 桌面端：遵循现有代码风格（无 ESLint，靠人工审查）
- Android 端：遵循 Kotlin 官方编码规范
- 注释：关键逻辑必须有注释
- 命名：变量名、函数名必须有意义

## 测试要求

- 新功能必须有对应测试
- Bug 修复必须有回归测试
- 确保 `npm test` 和 `./gradlew testDebugUnitTest` 通过

## 许可证

本项目使用 AGPL-3.0 许可证。贡献代码即表示你同意你的贡献以相同许可证发布。
