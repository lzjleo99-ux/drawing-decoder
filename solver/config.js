// 解题系统的配置：科目、字体、版式。
//
// 字体与版式在此集中定义，屏幕预览、打印成 PDF、导出 Word 三条路径共用同一张表 ——
// 这是"输出版式一致"的实现基础，三边不允许各自硬编码。

export const SUBJECTS = {
  mech_eng: { name: '机械工程', nameEn: 'Mechanical Engineering',
    modules: ['齿轮传动', '轴承校核', '公差配合', '机构运动仿真'], diagrams: true },
  metal_forming: { name: '金属成型原理', nameEn: 'Metal Forming',
    modules: ['主应力法', '滑移线场', '挤压变形抗力', '板料冲压'], diagrams: true },
  theoretical_mech: { name: '理论力学 / 材料力学', nameEn: 'Theoretical & Material Mechanics',
    modules: ['静力学平衡', '受力图', '梁的内力', '应力状态分析'], diagrams: true },
  adv_math: { name: '高等数学', nameEn: 'Advanced Mathematics',
    modules: ['微积分', '级数', '常微分方程', '空间解析几何'], diagrams: false },
  linear_algebra: { name: '线性代数', nameEn: 'Linear Algebra',
    modules: ['矩阵运算', '特征值与特征向量', '二次型', '线性方程组'], diagrams: false },
  other: { name: '其他理工科', nameEn: 'Other Science & Engineering', modules: [], diagrams: true },
};

// 每种字体同时给出 CSS 栈（屏幕/打印）与 Word 字体名（DOCX）。
// Word 要分别指定 ascii（西文/公式）与 eastAsia（中文），否则中英混排会错字体。
export const FONTS = {
  'font-sans-sc': {
    label: '黑体 / 微软雅黑（工程文档）',
    css: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Noto Sans SC','Source Han Sans SC',sans-serif",
    docx: { ascii: 'Arial', eastAsia: '微软雅黑' },
  },
  'font-serif-sc': {
    label: '宋体 / 仿宋（学术试卷）',
    css: "'Songti SC','SimSun','Noto Serif CJK SC','Noto Serif SC','Source Han Serif SC',serif",
    docx: { ascii: 'Times New Roman', eastAsia: '宋体' },
  },
  'font-mono': {
    label: '等宽体（代码与公式）',
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
export const PDF_VISION_MAX_PAGES = 10;
// 页面栅格化倍率：1.5 倍下 A4 约 892×1262 像素，公式细节足够且不浪费 token
export const PDF_RENDER_SCALE = 1.5;
