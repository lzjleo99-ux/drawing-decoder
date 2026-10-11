# 智解工科与理科试卷/作业系统

> **这个版本已并入 [机械工程学习网页](https://lzjleo99-ux.github.io/drawing-decoder/)。**
>
> 并入后的版本是纯浏览器实现（[drawing-decoder 仓库](https://github.com/lzjleo99-ux/drawing-decoder)
> 的 `solver.html` + `solver/`），不需要服务器，每位用户填自己的 API Key，
> 和图纸解译台共用同一把 Key。**日常使用请用那个。**
>
> 本仓库保留的是最初的 Node 服务端版本。两者功能相同，差别只在：
> 服务端版用无头 Chrome 直接生成 PDF（浏览器版走打印对话框），
> 且 Key 放在服务端环境变量里（因此不适合多人共用）。

上传 `.docx` / `.pdf` 作业或试卷，调用 Claude 逐题求解，导出**版式一致**的 Word 与 PDF 答卷。

Word 里的公式是 **OMML 原生公式对象**（可以在 Word 里双击编辑），不是图片，也不需要 pandoc 或 LaTeX。

## 在 GitHub 上运行（Codespaces）

不想在本地装环境就用这个。仓库已配好 [.devcontainer](.devcontainer)，开箱即用。

1. 在仓库页面点 **Code → Codespaces → Create codespace on main**
2. 首次创建会自动装 chromium、中文字体、依赖，并跑一遍测试（约 2–3 分钟）
3. 终端执行 `npm start`
4. 在 **PORTS** 面板找到 3000 端口，点地球图标打开

要真正解题，得先配密钥：到 <https://github.com/settings/codespaces> →
**Codespaces secrets** → 新建 `ANTHROPIC_API_KEY`，并授权给本仓库，然后重建 Codespace。
没配密钥也能启动，但只能跑空跑模式：`SOLVER_DRY_RUN=1 npm start`。

转发出来的端口**默认是私有的**，只有你自己能访问。要分享给别人，在 PORTS 面板右键该端口
→ Port Visibility → Public。

> **GitHub Pages 跑不了这个应用。** Pages 只托管静态文件，而本项目需要 Node 服务端
> （解析 .docx、调用 Claude API、用无头 Chrome 生成 PDF）。想要一个长期在线的公网地址，
> 需要部署到 Render / Railway / Fly.io 这类支持常驻 Node 进程的平台，并在那边同样装上
> chromium 与 `fonts-noto-cjk`。

## 快速开始

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start                 # http://localhost:3000
```

没有 API 密钥也可以先验证整条链路（不调模型、不花钱）：

```bash
SOLVER_DRY_RUN=1 npm start
```

空跑模式会把**从文档里抽取到的内容和还原出的公式**直接排版导出，用来检查上传、
抽取、公式还原、排版、导出这五段是否正常，以及公式有没有抽丢抽错。

```bash
npm test                  # 72 项测试，含一次完整的 HTTP 端到端流程
npm run fixtures          # 重新生成 test/fixtures 下的测试文件
```

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 20 | 本机在 Node 24 上开发与测试 |
| Chrome / Chromium / Edge / Brave | 仅用于生成 PDF；macOS 与 Linux 常见路径都会自动查找，也可用 `CHROME_PATH` 指定 |
| `ANTHROPIC_API_KEY` | 真实求解必需；空跑模式不需要 |

**不需要** pandoc、LaTeX、LibreOffice。这是选型的硬约束：本机装不了它们，
所以整条公式链路是纯 JS 的。

配置项见 [.env.example](.env.example)。

## 工作流程

```
上传 .docx/.pdf
   │
   ├─ .docx → 自己遍历 document.xml：正文 + 表格 + OMML 公式还原成 LaTeX + 内嵌图片
   └─ .pdf  → 原始字节直接作为 document 块交给 Claude（能同时看到文字/公式/图形）
                                    + pdfjs 抽出文字层作为辅助
   │
   ├─ 第一阶段：拆题（结构化输出 → 题号 / 题干 / 引用的图）
   └─ 第二阶段：逐题求解（结构化输出 → 语义块：正文 / 公式 / 图 / 表 / 答案）
   │
   └─ 渲染（三条路径共用 src/config.js 的字体与版式表）
        ├─ HTML  ← temml → MathML，自包含，预览与 PDF 同一份
        ├─ PDF   ← 无头 Chrome 打印上面那份 HTML
        └─ DOCX  ← temml → MathML → mathml2omml → Word 原生公式
```

## 几个关键设计

**公式为什么能进 Word 还可编辑。** `temml` 把 LaTeX 转成 MathML，`mathml2omml`
再转成 OMML，最后作为原始 XML 注入 docx。整条链路纯 JS，不依赖 pandoc。
转换失败的公式不会悄悄变成图片，而是以**高亮的 LaTeX 源码**留在文档里并计入统计 ——
掩盖失败比暴露失败更糟。

**为什么不用 mammoth 读 Word。** mammoth 会把公式整段丢弃，而公式对理工科试卷就是题目本身。
自己遍历 `document.xml` 才能让公式**留在它原本的位置**（"求下式的积分"后面必须跟着那个式子）。
附带好处：去掉 mammoth 后依赖树里没有已知漏洞。

**版式一致怎么保证的。** 字体、页边距、行距只在 [src/config.js](src/config.js) 定义一次，
DOCX 渲染器和 HTML/PDF 渲染器都从那里读。预览用 iframe 加载的就是生成 PDF 的那份 HTML，
不是另画一套，所以"预览所见"和"PDF 所得"不可能不一致。

**公式溢出是真的测量出来的。** 页内脚本在 Chrome 里量出公式的自然宽度与可用宽度，
超宽先按比例缩放，缩到 0.6 以下改为断行，并把**实际调整结果**回报到求解日志。
日志里的"N 个公式已缩放"是量出来的，不是写死的提示语。

**成本。** 源文档放在每次请求的同一段可缓存前缀里，一份 10 题的试卷只上传一次源文档；
第一题先单独跑以写入缓存，其余题目再并发，这样后续请求才能命中。

**模型产出的 SVG 当成不可信输入。** 白名单清洗（剥离 `<script>`、`on*` 事件、外部引用）
之后才注入预览，预览 iframe 因此可以放开 `allow-scripts` 让溢出重排脚本运行。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/config` | 科目、字体、体积上限、版式参数（前端据此渲染表单） |
| `POST` | `/api/jobs` | multipart：`file` / `subject` / `font` / `autoLayout` / `autoDraw` → `202 {jobId}` |
| `GET` | `/api/jobs/:id/events` | SSE：`log` / `done` / `error`；连接前的日志会补发 |
| `GET` | `/api/jobs/:id/preview` | 答卷 HTML（与 PDF 同源） |
| `GET` | `/api/jobs/:id/download/docx\|pdf` | 下载 |

## 已知限制

- **Word 里的 EMF/WMF 图片读不了。** Word 粘贴的图表常是这种矢量格式，无法解码送入识别。
  系统会明确告警，建议在 Word 里把图另存为 PNG 后重试，而不是假装没这回事。
- **超过 20MB 的 PDF 退回纯文字层。** Claude 的 document 块有请求体积上限，
  超过时图形题可能识别不全，日志会告警。
- **DOCX 没有溢出测量。** Word 那条路径没有布局引擎量不了宽度，
  只能靠提示词要求模型"每个公式只写一步"从源头规避；PDF 那条是实测的。
- **Linux 上需要自己装中文字体。** 容器或服务器环境若没有 `fonts-noto-cjk`，
  PDF 里的中文会变成豆腐块。Codespaces 的 devcontainer 已经装好，自行部署时别漏。
- **任务存在内存里。** 服务重启后历史任务和下载链接失效。单机小工具不值得为此上数据库。
- **扫描件完全依赖视觉识别。** 没有文字层时日志会提示，识别质量取决于扫描清晰度。
- **未接入服务端 refusal fallback。** `fallbacks` 参数需要 beta 的 create 路径，
  与结构化输出的 `messages.parse()` helper 不能同时用。代码显式检查了
  `stop_reason === 'refusal'` 并给出可读报错；理工科解题内容触发拒答的可能性很低。

## 目录结构

```
server.js              HTTP 服务、任务队列、SSE
src/config.js          科目 / 字体 / 版式 / 模型参数（唯一来源）
src/extract/
  omml2latex.js        Word 公式 (OMML) → LaTeX
  docx.js              .docx 抽取（正文 / 表格 / 公式 / 图片）
  pdf.js               .pdf 文字层抽取 + 视觉通道判定
src/solve/
  prompts.js           系统提示词（逐字节稳定，作为缓存前缀）
  schema.js            结构化输出的 Zod 模式
  solver.js            两阶段求解、并发、缓存、错误翻译
  dryrun.js            空跑模式
src/render/
  math.js              LaTeX → MathML / OMML，公式与文本切分
  svg.js               模型产出 SVG 的白名单清洗
  html.js              自包含 HTML（预览与 PDF 同源）
  docx.js              .docx 渲染（OMML 原生公式）
  pdf.js               无头 Chrome 打印
public/                前端
test/run.js            测试
```
