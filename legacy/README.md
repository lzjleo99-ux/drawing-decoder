# legacy/ —— 已退役的 Node 服务端版本

本目录**不是本站的一部分**，任何页面都不引用它。保留它只为两点：可追溯、以及在被误删时能还原。

## 这是什么

`zhijie-solver-node-server/` 是「作业解答」功能**并入本站之前**的原始实现，来自已删除的仓库
`lzjleo99-ux/zhijie-solver`（2026-10-10 归档）。那一版是一个常驻 Node 服务：Express 起 HTTP 服务、
内存任务队列 + SSE 推日志、服务端持有 `ANTHROPIC_API_KEY`、用无头 Chrome（`puppeteer-core`）
把 HTML 打印成 PDF。

本站的「作业解答」（`solver.html` + `solver/`）是它的**纯浏览器重写**：没有后端，
每位访客填自己的 Key，请求从浏览器直连厂商，PDF 走浏览器打印对话框。

## 为什么整体退役而不是继续维护

服务端版与本站的架构直接冲突：

| 服务端版 | 本站 |
|---|---|
| 需要常驻 Node 进程（Render / Railway / Fly.io / Codespaces） | 静态托管（GitHub Pages）即可 |
| Key 放在服务端环境变量，多人共用一个 | 每人填自己的 Key，只存在本人浏览器 |
| 无头 Chrome 生成 PDF | 浏览器打印对话框，屏幕所见即打印所得 |
| Zod + `messages.parse()` 保证结构化输出 | 桥接层无此能力，改为提示词约束 + 运行时校验 |
| 有 `SOLVER_DRY_RUN=1` 空跑模式 | 无（无密钥时无法自检整条链路） |

最后一项是**唯一的能力缺失**：空跑模式没有被带过来。其余差异都是刻意的架构取舍，功能等价。

## 这里没有的东西

为了不把一个静态站变成 Node 项目，归档时**刻意没有**把 `package.json`、`.devcontainer/`
放到仓库根目录 —— 放在根目录会让 GitHub 与 npm 工具链误认为本仓库是 Node 项目。
它们连同 `server.js`、`package-lock.json`、`.env.example` 一起，原样留在本目录内部。

## 目录内容

```
zhijie-solver-node-server/
  server.js              Express 服务、任务队列、SSE
  package.json           依赖清单（express / puppeteer-core / zod / docx / temml …）
  package-lock.json      锁定版本
  .env.example           服务端环境变量样例
  .devcontainer/         Codespaces 配置（装 chromium + 中文字体）
  public/                旧前端（app.js + index.html）
  src/                   服务端实现（extract / render / solve）
  test/                  原测试套件（416 行）与夹具
  README.md              该版本自己的说明（含 HTTP 接口表）
```

## 想跑起来的话

本目录内是自洽的 Node 项目，但需要先装依赖并准备无头 Chrome：

```bash
cd legacy/zhijie-solver-node-server
npm ci
SOLVER_DRY_RUN=1 npm start     # 空跑模式，不需要 API Key
npm test                        # 72 项测试
```

注意：**这是历史版本，不再修复问题**。日常使用请用本站的 `solver.html`。
