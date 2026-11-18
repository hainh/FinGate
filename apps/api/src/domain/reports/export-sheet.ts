/**
 * Xuất Excel/CSV cho mọi preset báo cáo (arch §9 K-12 · DS §4: UI và file xuất dùng chung nguồn số).
 *
 * Vì sao có file này: `reportPreset` trả `rows` chứa tiền dưới dạng `WireAmount`
 * (`{ minor: "2500000000", currency: "VND", decimals: 0 }`) — đúng cho API (tiền trên wire luôn là
 * chuỗi, arch §8.5) nhưng SAI cho bảng tính: `jsonSafe` chỉ biến BigInt thành chuỗi, nên ô Excel
 * nhận nguyên văn `{"minor":"2500000000","currency":"VND","decimals":0}` dưới dạng TEXT → không
 * SUM/PIVOT/lọc số được.
 *
 * Quy ước file xuất — CHỈ SỐ THÔ, không dòng TỔNG (người dùng tự Sum trong Excel):
 *  · mỗi cột tiền (`money`/`compact`) → MỘT cột SỐ thật (đơn vị lớn, format `#,##0`);
 *  · đơn vị tiền nằm ở CỘT KHÁC, không lẫn vào ô số:
 *      – cả bảng dùng chung MỘT loại tiền (VND — gần như luôn đúng) → ĐÚNG MỘT cột "Đơn vị" ở cuối
 *        bảng, file gọn (báo cáo 6 cột tiền vẫn chỉ thêm 1 cột);
 *      – bảng lẫn nhiều loại tiền (vd số dư tài khoản USD + VND) → cột "… — đơn vị" riêng ngay sau
 *        TỪNG cột tiền, vì một ô "Đơn vị" chung lúc đó sẽ mô tả sai cột này;
 *  · số chữ số thập phân lấy theo MÃ TIỀN (`currencyDecimals`), KHÔNG theo trường `decimals` trên
 *    wire: `wire()` luôn ghi 0 → nếu dùng trường đó thì USD/EUR bị xuất to gấp 100 lần;
 *  · cột `number`/`days`/`percent` cũng là số thật có định dạng (percent hiển thị `0.0"%"` nhưng vẫn
 *    là số 0–100, không phải chuỗi "12,5%");
 *  · cột `date` là Date trong Excel (format dd/mm/yyyy) để sort/filter/lọc theo tháng đúng;
 *  · ô là số/text/ngày — tuyệt đối không còn object/array/JSON.
 */

import { currencyDecimals } from '@fingate/shared';
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import type { ReportColumn } from './index.ts';

/** Giá trị ô sau khi làm phẳng — chỉ kiểu nguyên thuỷ Excel nhận (số / ngày / text). */
export type SheetValue = string | number | Date | null;

export interface SheetColumn {
  key: string;
  header: string;
  width: number;
  align: 'left' | 'right' | 'center';
  /** `numFmt` Excel; bỏ trống = General (text). */
  numFmt?: string;
  kind: 'money' | 'unit' | 'number' | 'percent' | 'date' | 'text';
}

export interface ExportSheet {
  columns: SheetColumn[];
  /** dữ liệu theo đúng thứ tự `columns` (mảng vị trí — không phụ thuộc tên khoá). */
  rows: SheetValue[][];
}

const MONEY_TYPES = new Set(['money', 'compact']);
const NUMERIC_TYPES = new Set(['number', 'days']);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Định dạng nhóm hàng nghìn; `decimals` > 0 thêm chữ số thập phân (USD/EUR). */
function moneyFmt(decimals: number): string {
  return decimals > 0 ? `#,##0.${'0'.repeat(Math.min(4, decimals))}` : '#,##0';
}

/** minor (BigInt, đơn vị nhỏ nhất của loại tiền) → số thập phân ghi vào ô, giữ đúng dấu. */
export function scaleMinor(minor: bigint, decimals: number): number {
  const dec = Math.max(0, decimals);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(dec + 1, '0');
  const cut = digits.length - dec;
  const text = dec > 0 ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  const n = Number(text);
  return negative ? -n : n;
}

/** BigInt hoá minor dạng "trần": bigint / number / chuỗi số / bson Long (String() ra dãy số). */
function toMinorBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /^-?\d+$/.test(s) ? BigInt(s) : null;
}

interface MoneyParts {
  minor: bigint;
  currency: string;
  decimals: number;
}

/**
 * Nhận mọi hình thái tiền trên wire: `WireAmount`/`{minor, currency}` (arch §8.5), BigInt,
 * chuỗi số nguyên minor, bson Long. `null` = không phải tiền → người gọi giữ text (không bịa 0).
 */
function parseMoney(raw: unknown): MoneyParts | null {
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (rec.minor !== undefined && rec.minor !== null && rec.minor !== '') {
      const minor = toMinorBigInt(rec.minor);
      if (minor === null) return null;
      const currency = String(rec.currency ?? 'VND').toUpperCase() || 'VND';
      return { minor, currency, decimals: currencyDecimals(currency) };
    }
  }
  const bare = toMinorBigInt(raw);
  return bare !== null ? { minor: bare, currency: 'VND', decimals: 0 } : null;
}

/** Text hoá giá trị còn lại — tuyệt đối không để lọt JSON/object ra ô. */
function toText(raw: unknown): SheetValue {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw ? 'Có' : 'Không';
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : '';
  if (typeof raw === 'bigint') return scaleMinor(raw, 0);
  if (raw instanceof Date) return raw;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.toHexString === 'function') return String((rec as { toHexString(): string }).toHexString());
  const money = parseMoney(rec);
  if (money) return scaleMinor(money.minor, money.decimals);
  for (const nameKey of ['name', 'label', 'title'] as const) {
    const v = rec[nameKey];
    if (typeof v === 'string' && v) return v;
  }
  const code = String(rec.code ?? '');
  if (/^[A-Z]{3}$/.test(code)) return code; // mã tiền đứng một mình ('VND')
  return '';
}

/** Cột ngày: phần YYYY-MM-DD → Date (Excel hiểu, sort/filter được); chuỗi khác → text. */
function toDateValue(raw: unknown): SheetValue {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? '' : new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
  }
  const s = String(raw).trim();
  if (DATE_ONLY_RE.test(s)) return new Date(`${s}T00:00:00Z`);
  const day = s.slice(0, 10);
  if (DATE_ONLY_RE.test(day)) return new Date(`${day}T00:00:00Z`);
  return toText(raw);
}

/** Cột số: Number thật; chuỗi kiểu VN "9,5" → 9.5; không parse được → text gốc (không bịa 0). */
function toNumberValue(raw: unknown): SheetValue {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : '';
  if (typeof raw === 'bigint') return scaleMinor(raw, 0);
  const money = parseMoney(raw);
  if (money) return scaleMinor(money.minor, 0);
  const t = String(raw).trim().replace(/\s/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : toText(raw);
}

const WIDTHS: Record<SheetColumn['kind'], number> = { money: 22, unit: 13, number: 14, percent: 14, date: 14, text: 28 };
const UNIT_HEADER = 'Đơn vị';

/**
 * Khai báo cột + dòng của `reportPreset` → mô hình bảng tính phẳng: tiền là SỐ, đơn vị ở cột riêng.
 * Đọc `rows` HAI lượt: lượt đầu để biết bảng dùng một hay nhiều loại tiền (quyết định bố cục cột),
 * lượt sau mới dựng ô — nên ô đơn vị luôn đúng với số bên cạnh.
 */
export function buildExportSheet(columns: readonly ReportColumn[], rows: readonly Record<string, unknown>[]): ExportSheet {
  // 1) dò tiền: loại tiền nào xuất hiện, cột tiền nào cần bao nhiêu chữ số thập phân
  const currencies = new Set<string>();
  const decimalsByCol = new Map<string, number>();
  for (const c of columns) {
    if (!MONEY_TYPES.has(c.type)) continue;
    for (const row of rows) {
      const m = parseMoney(row[c.key]);
      if (!m) continue;
      currencies.add(m.currency);
      decimalsByCol.set(c.key, Math.max(decimalsByCol.get(c.key) ?? 0, m.decimals));
    }
  }
  /** 1 loại tiền duy nhất → 1 cột "Đơn vị" chung; lẫn tiền → cột đơn vị riêng theo từng cột tiền; không có tiền → không thêm cột. */
  const sharedCurrency = currencies.size === 1 ? [...currencies][0]! : '';
  const perColumnUnit = currencies.size > 1;

  // 2) dựng bố cục cột
  const sheetColumns: SheetColumn[] = [];
  const moneyIdx = new Map<string, number>();
  const unitIdx = new Map<string, number>();
  const cellIdx = new Map<string, number>();
  const unitConst = new Map<string, string>();

  for (const c of columns) {
    if (MONEY_TYPES.has(c.type)) {
      moneyIdx.set(c.key, sheetColumns.length);
      sheetColumns.push({
        key: c.key,
        header: c.label,
        width: WIDTHS.money,
        align: 'right',
        numFmt: moneyFmt(decimalsByCol.get(c.key) ?? 0),
        kind: 'money',
      });
      if (perColumnUnit) {
        unitIdx.set(c.key, sheetColumns.length);
        sheetColumns.push({ key: `${c.key}__don_vi`, header: `${c.label} — đơn vị`, width: WIDTHS.unit, align: 'center', kind: 'unit' });
      }
    } else if (c.unit) {
      // giá trị số lưu dạng chuỗi (vd lãi suất "9,5") → SỐ + cột đơn vị riêng, luôn sát cột đó
      cellIdx.set(c.key, sheetColumns.length);
      sheetColumns.push({ key: c.key, header: c.label, width: WIDTHS.number, align: 'right', numFmt: '#,##0.###', kind: 'number' });
      sheetColumns.push({ key: `${c.key}__don_vi`, header: `${c.label} — đơn vị`, width: WIDTHS.unit, align: 'center', kind: 'unit' });
      unitConst.set(c.key, c.unit);
    } else if (c.type === 'percent') {
      cellIdx.set(c.key, sheetColumns.length);
      sheetColumns.push({ key: c.key, header: c.label, width: WIDTHS.percent, align: 'right', numFmt: '0.0"%"', kind: 'percent' });
    } else if (NUMERIC_TYPES.has(c.type)) {
      cellIdx.set(c.key, sheetColumns.length);
      sheetColumns.push({ key: c.key, header: c.label, width: WIDTHS.number, align: 'right', numFmt: '#,##0', kind: 'number' });
    } else if (c.type === 'date') {
      cellIdx.set(c.key, sheetColumns.length);
      sheetColumns.push({ key: c.key, header: c.label, width: WIDTHS.date, align: 'center', numFmt: 'dd/mm/yyyy', kind: 'date' });
    } else {
      cellIdx.set(c.key, sheetColumns.length);
      sheetColumns.push({
        key: c.key,
        header: c.label,
        width: Math.max(WIDTHS.text, Math.min(46, c.label.length + 12)),
        align: c.align === 'center' ? 'center' : 'left',
        kind: 'text',
      });
    }
  }
  // đúng MỘT loại tiền trong cả bảng → thêm MỘT cột "Đơn vị" ở cuối (không có ô tiền nào → không thêm cột)
  let sharedUnitIdx = -1;
  if (sharedCurrency) {
    sharedUnitIdx = sheetColumns.length;
    sheetColumns.push({ key: '__don_vi', header: UNIT_HEADER, width: WIDTHS.unit, align: 'center', kind: 'unit' });
  }

  // 3) dựng ô
  const outRows: SheetValue[][] = rows.map((row) => {
    const cells = new Array<SheetValue>(sheetColumns.length).fill('');
    for (const c of columns) {
      const raw = row[c.key];
      const mI = moneyIdx.get(c.key);
      if (mI !== undefined) {
        const money = parseMoney(raw);
        if (money) {
          cells[mI] = scaleMinor(money.minor, money.decimals);
          if (perColumnUnit) cells[unitIdx.get(c.key)!] = money.currency;
        } else {
          cells[mI] = toText(raw); // tiền đã định dạng sẵn (hiếm) → giữ text, không bịa số
        }
        continue;
      }
      const idx = cellIdx.get(c.key)!;
      const fixed = unitConst.get(c.key);
      if (fixed !== undefined) {
        const n = toNumberValue(raw);
        cells[idx] = n;
        if (n !== '') cells[idx + 1] = fixed;
        continue;
      }
      if (c.type === 'date') cells[idx] = toDateValue(raw);
      else if (NUMERIC_TYPES.has(c.type) || c.type === 'percent') cells[idx] = toNumberValue(raw);
      else cells[idx] = toText(raw);
    }
    // một loại tiền chung cả bảng → ghi mã tiền vào MỌI dòng để lọc/pivot ổn định (kể dòng không có tiền)
    if (sharedUnitIdx >= 0) cells[sharedUnitIdx] = sharedCurrency;
    return cells;
  });

  return { columns: sheetColumns, rows: outRows };
}

/** Tên sheet hợp lệ: Excel chặn `: \ / ? * [ ]`, ký tự điều khiển, và tối đa 31 ký tự. */
export function sheetNameOf(title: string): string {
  let out = '';
  for (const ch of String(title ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 ? ' ' : ':\\/?*[]'.includes(ch) ? '·' : ch;
  }
  return (out.trim() || 'Bieu mau').slice(0, 31);
}

/** 1 → A, 27 → AA. */
export function colLetter(n: number): string {
  let s = '';
  let i = Math.max(1, Math.floor(n));
  while (i > 0) {
    const rem = (i - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export interface XlsxOptions {
  /** tên tab = tiêu đề báo cáo. */
  sheetName?: string;
  /** dòng watermark "Xuất bởi … · scope" ở cuối (arch §9 — mọi file có dấu người xuất). */
  watermark?: string;
  filename?: string;
}

/**
 * Ghi bảng tính ra stream (exceljs streaming — K-12: không giữ cả workbook trong RAM ở trần 50k dòng).
 * `useStyles: true` là BẮT BUỘC: thiếu nó exceljs dùng StylesXform.Mock và âm thầm bỏ hết numFmt/font
 * → ô tiền trở về General, mất định dạng hàng nghìn.
 */
export async function writeXlsx(sheet: ExportSheet, stream: Writable, opts: XlsxOptions = {}): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: opts.filename ?? 'export.xlsx',
    stream,
    useSharedStrings: true,
    useStyles: true,
  });
  const ws = wb.addWorksheet(sheetNameOf(opts.sheetName ?? ''), { views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }] });

  // chỉ đặt width + key (không đặt `header`: dòng 1 tự ghi để kiểm soát font/fill)
  ws.columns = sheet.columns.map((c) => ({ key: c.key, width: c.width }));

  const header = ws.addRow(sheet.columns.map((c) => c.header));
  header.height = 22;
  header.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const c = sheet.columns[colNumber - 1];
    if (!c) return;
    cell.font = { bold: true };
    cell.alignment = { horizontal: c.align, vertical: 'middle', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F5F9' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFCAD6' } } };
  });
  header.commit();

  for (const values of sheet.rows) {
    const row = ws.addRow(values);
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const c = sheet.columns[colNumber - 1];
      if (!c) return;
      if (c.numFmt) cell.numFmt = c.numFmt;
      cell.alignment = { horizontal: c.align };
    });
    row.commit();
  }

  if (opts.watermark) {
    const note = ws.addRow([opts.watermark]);
    note.getCell(1).font = { italic: true, color: { argb: 'FF8A8A8A' } };
    note.commit();
  }

  // autoFilter đúng vùng dữ liệu, KHÔNG gồm dòng watermark (không lọt "Xuất bởi…" vào danh sách lọc)
  if (sheet.columns.length) ws.autoFilter = { from: 'A1', to: `${colLetter(sheet.columns.length)}${sheet.rows.length + 1}` };

  ws.commit();
  await wb.commit();
}

/** Số trong CSV dùng dấu PHẨY thập phân (locale vi-VN → Excel đọc ra SỐ, SUM được). */
function csvNumber(v: number, numFmt?: string): string {
  let decimals = 0;
  if (numFmt?.includes('.')) decimals = numFmt.slice(numFmt.indexOf('.') + 1).replace(/[^0#]/g, '').length;
  const fixed = decimals > 0 ? v.toFixed(decimals) : String(v);
  return fixed.replace('.', ',');
}

function csvText(v: SheetValue): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) {
    s = `${String(v.getUTCDate()).padStart(2, '0')}/${String(v.getUTCMonth() + 1).padStart(2, '0')}/${v.getUTCFullYear()}`;
  } else if (typeof v === 'number') {
    s = csvNumber(v);
  } else {
    s = String(v);
  }
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV cho `format: 'csv'` (hợp đồng `exportRequestBody` khai báo csv — trước đây route bỏ qua, tải về
 * luôn là .xlsx). Phân cách `;` + BOM: tiếng Việt không lỗi font, số không bị đọc thành text.
 */
export function toCsv(sheet: ExportSheet, watermark?: string): string {
  const lines: string[] = [sheet.columns.map((c) => csvText(c.header)).join(';')];
  for (const values of sheet.rows) {
    lines.push(values.map((v, i) => (typeof v === 'number' ? csvNumber(v, sheet.columns[i]?.numFmt) : csvText(v))).join(';'));
  }
  if (watermark) lines.push(csvText(watermark));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
