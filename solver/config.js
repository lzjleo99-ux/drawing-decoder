// 解题系统的配置：科目、字体、版式。
//
// 字体与版式在此集中定义，屏幕预览、打印成 PDF、导出 Word 三条路径共用同一张表 ——
// 这是"输出版式一致"的实现基础，三边不允许各自硬编码。

export const SUBJECTS = {
  mech_eng: { i18n: 'solver.subj.mech_eng', mod: 'solver.mod.mech_eng', en: 'Mechanical Engineering', diagrams: true },
  metal_forming: { i18n: 'solver.subj.metal_forming', mod: 'solver.mod.metal_forming', en: 'Metal Forming', diagrams: true },
  theoretical_mech: { i18n: 'solver.subj.theoretical_mech', mod: 'solver.mod.theoretical_mech', en: 'Engineering & Material Mechanics', diagrams: true },
  adv_math: { i18n: 'solver.subj.adv_math', mod: 'solver.mod.adv_math', en: 'Advanced Mathematics', diagrams: false },
  linear_algebra: { i18n: 'solver.subj.linear_algebra', mod: 'solver.mod.linear_algebra', en: 'Linear Algebra', diagrams: false },
  other: { i18n: 'solver.subj.other', mod: 'solver.mod.other', en: 'Other science & engineering', diagrams: true },
};

// 每种字体同时给出 CSS 栈（屏幕/打印）与 Word 字体名（DOCX）。
// Word 要分别指定 ascii（西文/公式）与 eastAsia（中文），否则中英混排会错字体。
export const FONTS = {
  'font-sans-sc': {
    i18n: 'solver.font.sans',
    css: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Noto Sans SC','Source Han Sans SC',sans-serif",
    docx: { ascii: 'Arial', eastAsia: '微软雅黑' },
  },
  'font-serif-sc': {
    i18n: 'solver.font.serif',
    css: "'Songti SC','SimSun','Noto Serif CJK SC','Noto Serif SC','Source Han Serif SC',serif",
    docx: { ascii: 'Times New Roman', eastAsia: '宋体' },
  },
  'font-mono': {
    i18n: 'solver.font.mono',
    css: "'IBM Plex Mono','JetBrains Mono',Menlo,Consolas,monospace",
    docx: { ascii: 'Consolas', eastAsia: '等线' },
  },
};

export const DEFAULT_FONT = 'font-sans-sc';

export const LAYOUT = {
  marginMm: 25.4,
  lineSpacing: 1.25,
  bodyPt: 11,
  // 公式超宽时允许的最小缩放比例，低于此值改为允许断行而不是继续缩到不可读
  minEquationScale: 0.6,
};

export const UPLOAD = {
  maxBytes: 30 * 1024 * 1024,
  allowedExt: ['.docx', '.pdf'],
};

// 桥接层单次最多送 12 张图，这里留点余量给 docx 内嵌图
// 正文字号候选。auto = 用从原卷里量出来的字号，量不到时退回 LAYOUT.bodyPt。
// 中文习惯：五号=10.5pt，小四=12pt，四号=14pt
export const BODY_SIZES = ['auto', 10.5, 11, 12, 14];

export const PDF_VISION_MAX_PAGES = 10;
// 页面栅格化倍率：1.5 倍下 A4 约 892×1262 像素，公式细节足够且不浪费 token
export const PDF_RENDER_SCALE = 1.5;
