// 全局配置：科目、字体映射、版式规则。
// 字体与版式在此集中定义，HTML/PDF 渲染器与 DOCX 渲染器共用同一张表，
// 这是"输出版式一致"的实现基础 —— 两条输出路径不允许各自硬编码字体。

export const SUBJECTS = {
  mech_eng: {
    name: '机械工程',
    nameEn: 'Mechanical Engineering',
    modules: ['齿轮传动', '轴承校核', '公差配合', '机构运动仿真'],
    diagrams: true,
  },
  metal_forming: {
    name: '金属成型原理',
    nameEn: 'Metal Forming',
    modules: ['主应力法', '滑移线场', '挤压变形抗力', '板料冲压'],
    diagrams: true,
  },
  adv_math: {
    name: '高等数学',
    nameEn: 'Advanced Mathematics',
    modules: ['微积分', '级数', '常微分方程', '空间解析几何'],
    diagrams: false,
  },
  linear_algebra: {
    name: '线性代数',
    nameEn: 'Linear Algebra',
    modules: ['矩阵运算', '特征值与特征向量', '二次型', '线性方程组'],
    diagrams: false,
  },
  theoretical_mech: {
    name: '理论力学 / 材料力学',
    nameEn: 'Theoretical & Material Mechanics',
    modules: ['静力学平衡', '受力图', '梁的内力', '应力状态分析'],
    diagrams: true,
  },
  other: {
    name: '其他理工科专业',
    nameEn: 'Other Science & Engineering',
    modules: [],
    diagrams: true,
  },
};

// 每种字体同时给出 CSS 栈（HTML/PDF）与 Word 字体名（DOCX）。
// Word 需要分别指定 ascii（西文/公式）与 eastAsia（中文）字体，否则中英文混排会错字体。
export const FONTS = {
  'font-sans-sc': {
    label: '中易黑体 / 微软雅黑（标准工程文档）',
    // 依次覆盖 macOS / Windows / Linux(Debian 的 fonts-noto-cjk 族名带 CJK) / 其他
    css: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Noto Sans SC','Source Han Sans SC','WenQuanYi Micro Hei',sans-serif",
    docx: { ascii: 'Arial', eastAsia: '微软雅黑' },
  },
  'font-serif-sc': {
    label: '中易宋体 / 仿宋（标准学术试卷）',
    css: "'Songti SC','SimSun','Noto Serif CJK SC','Noto Serif SC','Source Han Serif SC','AR PL UMing CN',serif",
    docx: { ascii: 'Times New Roman', eastAsia: '宋体' },
  },
  'font-mono': {
    label: '代码与公式专用等宽体',
    css: "'JetBrains Mono','Menlo','Consolas','DejaVu Sans Mono',monospace",
    docx: { ascii: 'Consolas', eastAsia: '等线' },
  },
};

export const DEFAULT_FONT = 'font-sans-sc';

export const LAYOUT = {
  marginMm: 25.4,
  lineSpacing: 1.25,
  // 正文字号：11pt。DOCX 用半点（22 = 11pt），CSS 用 pt。
  bodyPt: 11,
  // 公式超宽时允许的最小缩放比例，低于此值改为允许横向断行而不是继续缩小到不可读。
  minEquationScale: 0.6,
};

export const UPLOAD = {
  maxBytes: 50 * 1024 * 1024,
  allowedExt: ['.docx', '.pdf'],
  // Claude 原生 PDF document 块的请求上限为 32MB（base64 后更大），
  // 超过此阈值的 PDF 退回纯文本抽取，不走视觉通道。
  pdfVisionMaxBytes: 20 * 1024 * 1024,
};

export const MODEL = {
  id: 'claude-opus-5',
  // output_config.effort：理工科解题属于正确性敏感任务，默认 high，可用环境变量提到 max。
  effort: process.env.SOLVER_EFFORT || 'high',
  maxTokens: 16000,
  // 同时求解的题目数量，避免一次打满速率限制。
  concurrency: Number(process.env.SOLVER_CONCURRENCY || 3),
};
