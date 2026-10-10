// 按扩展名分派到对应的抽取器。
import { extractDocx } from './extract-docx.js';
import { extractPdf } from './extract-pdf.js';
import { UPLOAD } from './config.js';

export async function extract(file, log = () => {}) {
  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';

  if (!UPLOAD.allowedExt.includes(ext)) {
    throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}，仅支持 ${UPLOAD.allowedExt.join(' / ')}`);
  }
  if (file.size > UPLOAD.maxBytes) {
    throw new Error(`文件 ${(file.size / 1048576).toFixed(1)}MB 超过 ${UPLOAD.maxBytes / 1048576}MB 上限`);
  }
  if (file.size === 0) throw new Error('文件为空');

  const buf = await file.arrayBuffer();
  return ext === '.docx' ? extractDocx(buf) : extractPdf(buf, log);
}
