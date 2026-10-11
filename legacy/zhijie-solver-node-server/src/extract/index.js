// 按扩展名分派到对应的抽取器。
import path from 'node:path';
import { extractDocx } from './docx.js';
import { extractPdf } from './pdf.js';
import { UPLOAD } from '../config.js';

/**
 * @param {Buffer} buf 文件字节
 * @param {string} filename 原始文件名（只用于判断类型）
 */
export async function extract(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!UPLOAD.allowedExt.includes(ext)) {
    throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}，仅支持 ${UPLOAD.allowedExt.join(' / ')}`);
  }
  if (buf.length > UPLOAD.maxBytes) {
    throw new Error(`文件体积 ${(buf.length / 1048576).toFixed(1)}MB 超过上限 ${UPLOAD.maxBytes / 1048576}MB`);
  }
  if (ext === '.docx') return extractDocx(buf);
  return extractPdf(buf);
}
