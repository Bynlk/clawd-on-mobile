# 文档索引

> Clawd on Mobile 项目文档导航

---

## 📁 目录结构

```
docs/
├── README.md                    # 本文件：文档索引
├── project/                     # 项目架构文档
│   ├── agent-runtime-architecture.md  # 集成架构、数据流、多 agent
│   ├── theme-state-ui.md       # 状态机、主题系统、设置
│   ├── release-process.md      # 发版流程
│   └── fork-evaluation-and-improvement-plan.md  # Fork 质量评估
├── guides/                      # 用户指南
│   ├── setup-guide.md          # 安装指南
│   ├── guide-theme-creation.md # 主题创作指南
│   ├── guide-remote-ssh.md     # 远程 SSH 指南
│   ├── known-limitations.md    # 已知限制
│   └── ...                     # 各语言版本
├── mobile/                      # 移动端开发文档
│   ├── README.md               # 移动端开发索引
│   └── ...                     # 开发计划和 playbook
├── plans/                       # 功能计划文档
│   ├── PLAN-floating-approval.md  # 浮窗审批计划
│   ├── PLAN-remote-relay.md    # 远程中继计划
│   └── ...                     # 其他功能计划
├── releases/                    # 版本发布记录
│   └── release-v0.10.0.md      # v0.10.0 发布说明
├── compose/                     # Compose 相关文档
│   └── plans/                  # Compose 开发计划
└── investigations/              # 技术调查文档
    └── ...                     # 各种技术调查
```

---

## 🔗 快速导航

### 新手入门
- [安装指南](guides/setup-guide.md) — 如何安装和配置
- [已知限制](guides/known-limitations.md) — 当前版本的限制

### 开发者
- [项目架构](project/agent-runtime-architecture.md) — 整体架构设计
- [状态机与主题](project/theme-state-ui.md) — 状态机、主题系统
- [发版流程](project/release-process.md) — 如何发版

### 移动端开发
- [移动端开发索引](mobile/README.md) — Android 伴侣应用开发
- [浮窗审批计划](plans/PLAN-floating-approval.md) — 浮窗审批功能设计
- [远程中继计划](plans/PLAN-remote-relay.md) — 远程中继功能设计

### 主题创作
- [主题创作指南](guides/guide-theme-creation.md) — 如何创建自定义主题

### 远程功能
- [远程 SSH 指南](guides/guide-remote-ssh.md) — 远程机器连接
- [Telegram 审批指南](guides/guide-telegram-approval.md) — Telegram 远程审批

---

## 📝 文档规范

- 使用中文编写
- Markdown 格式
- 文件名使用小写字母和连字符
- 新增文档后更新本索引
