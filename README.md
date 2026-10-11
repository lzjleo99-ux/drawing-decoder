# 机械工程学习网页 · Mechanical Engineering Study

两个工具，一个站点，共用一把 Key。静态站，无后端 —— 每位访客填自己的 API Key，
只存在自己浏览器里，请求从浏览器直连厂商，不经过任何服务器。

| 页面 | 作用 |
|---|---|
| [index.html](index.html) · 图纸解译台 | 读机械图纸、工程图表、老设备控制程序，解释结构、公差、工作原理与材料性能，导出分析报告 |
| [solver.html](solver.html) · 作业解答 | 读 Word / PDF 作业与试卷，逐题给出完整推导与答案，导出 Word 与 PDF 答卷 |

- 语言：中文 / English / Srpski
- 访问：前端密码门（只挡随手访客，不是真正的账户系统）
- 支持：info@chinayytech.com

## 一把 Key，两边通用

两个页面同源（都在 `lzjleo99-ux.github.io` 下），共用同一份 `localStorage`，
也共用同一个 [local-bridge.js](local-bridge.js)。所以在任一页顶部填过 Key 和模型，
另一页打开就能直接用，不需要填两次。支持 Anthropic / DeepSeek / 智谱 / Apex。

## 作业解答：Word 里是真公式

导出的 .docx 里，公式是 **OMML 原生公式对象**，可以在 Word 里双击编辑，不是图片。

链路是 `LaTeX → temml → MathML → mathml2omml → OMML`，全程纯 JS 在浏览器里完成，
不需要 pandoc、LaTeX 或 Word。读取 .docx 时反向做同一件事：直接遍历 `document.xml`
把 Word 公式还原成 LaTeX（通用的 docx 解析库会把公式整段丢弃，而公式对理工科试卷
就是题目本身）。

PDF 走浏览器打印对话框导出（选"另存为 PDF"）。屏幕预览与打印用的是同一份 DOM 和
同一组版式参数，所以"预览所见"就是"PDF 所得"。

## 文件结构

```
index.html        图纸解译台
solver.html       作业解答
theme.css         共用设计系统：设计令牌与明暗主题、顶栏、导航、Key 工具条、
                  布局与面板、按钮、拖放区、进度条、语言切换、密码门、弹窗
i18n.js           三语文案（两个页面共用）
auth.js           前端密码门        accounts.js  账号哈希
local-bridge.js   Key 管理 + 多厂商 API 调用，对上暴露统一的 window.claude
app.js            图纸解译台的逻辑   admin.js / worker.js  管理与分享
solver/           作业解答的逻辑
  config.js         科目 / 字体 / 版式（三条输出路径共用，保证版式一致）
  extract.js        按扩展名分派
  extract-docx.js   .docx 抽取（正文 / 表格 / 公式 / 图片）
  extract-pdf.js    .pdf 文字层 + 页面栅格化送视觉识别
  omml2latex.js     Word 公式 (OMML) → LaTeX
  math.js           LaTeX → MathML / OMML
  svg.js            模型产出 SVG 的白名单清洗
  render-html.js    答卷渲染 + 公式溢出实测与缩放
  render-docx.js    .docx 生成（OMML 原生公式）
  prompts.js        提示词
  solve.js          两阶段求解（先拆题，再逐题并发）
  main.js           页面交互
test/             浏览器回归测试（见「测试」）
legacy/           已退役的 Node 服务端版本存档（见 legacy/README.md）
```

样式只属于某一个页面时，留在该页面自己的 `<style>` 里；两个页面都用的放 `theme.css`。

## 本地预览

静态站，任何静态服务器都行。注意要带 `charset=utf-8`，否则浏览器按 Latin-1
解析 JS，中文正则会报 `Range out of order`：

```bash
npx serve .        # 或任何会正确设置 charset 的静态服务器
node test/serve.mjs   # 本仓库自带的最小静态服务器，同样会带上 charset=utf-8
```

## 测试

```bash
node test/run.mjs
```

79 项回归测试，覆盖公式 OMML↔LaTeX 回环、`$` 切分、SVG 白名单清洗、配置表、
docx/pdf 抽取、HTML 与 DOCX 渲染、公式溢出实测，以及两阶段求解链路
（把 `window.claude` 换成 stub，不花 API 费用）。

测试跑在**真实浏览器**里（无头 Chrome + DevTools 协议），不是在 Node 里跑：
`solver/` 的模块从 CDN 以 `https://` URL import，Node 的 ESM 加载器不支持这种说明符；
公式溢出要真实布局引擎才量得出 `scrollWidth`；PDF 抽取要 canvas 栅格化页面。
在 Node 里硬跑只能把被测对象换成替身，那测的就不是真正发布出去的那份代码了。
需要本机有 Chrome / Chromium / Edge / Brave 之一，或用 `CHROME_PATH` 指定。

## 历史版本

`legacy/zhijie-solver-node-server/` 保留着并入本站之前的 Node 服务端实现
（Express + 无头 Chrome 出 PDF + 服务端持有 Key）。它已整体退役，本站任何页面都不引用它，
保留只为可追溯 —— 细节和差异对照见 [legacy/README.md](legacy/README.md)。

## 已知限制

- Word 里 EMF/WMF 格式的图读不了（粘贴的图表常是这种矢量格式），会明确告警，
  建议在 Word 里另存为 PNG 后重试。
- PDF 仅前 10 页送入视觉识别（单次请求的图片数量上限），其余页只用文字层。
- 扫描件完全依赖视觉识别，质量取决于扫描清晰度。
- 导出 Word 时无法测量公式宽度（没有布局引擎），靠提示词要求"每个公式只写一步"
  从源头规避超宽；屏幕与 PDF 那条路径是实测缩放的。
- 极个别公式转不成 Word 公式对象时，会在文档里保留高亮的 LaTeX 源码并计数上报，
  而不是悄悄塞一张图假装成功。
- `index.html` 没有 `<!DOCTYPE html>`，运行在怪异模式；`solver.html` 是标准模式。
  两者共用的顶栏实测渲染一致，但给 index.html 补 doctype 需要单独做回归验证。
