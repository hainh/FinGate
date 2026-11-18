import { describe, expect, it } from 'vitest';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { buildExportSheet, colLetter, scaleMinor, sheetNameOf, toCsv, writeXlsx } from './export-sheet.ts';
import type { ReportColumn } from './index.ts';

/** khai báo cột giống helper C/N/D/T trong `reports/index.ts`. */
const col = (key: string, label: string, type: ReportColumn['type'], align: ReportColumn['align'] = 'left'): ReportColumn => ({
  key,
  label,
  type,
  align,
});

const wire = (minor: string, currency = 'VND', decimals = 0) => ({ minor, currency, decimals });

describe('buildExportSheet — tiền là SỐ, đơn vị ở cột riêng, không có dòng TỔNG', () => {
  it('cả bảng một loại tiền → ĐÚNG MỘT cột "Đơn vị" ở cuối (file gọn, ô tiền là number)', () => {
    const sheet = buildExportSheet(
      [col('date', 'Ngày', 'date'), col('income', 'Thu', 'compact'), col('expense', 'Chi', 'compact'), col('documents', 'Số phiếu', 'number')],
      [
        { date: '2026-11-01', income: wire('2500000000'), expense: wire('-1500000000'), documents: 4, income_compact: '2,50 tỷ' },
        { date: '2026-11-02', income: wire('1000000000'), expense: wire('250000000'), documents: 2 },
      ],
    );

    expect(sheet.columns.map((c) => c.header)).toEqual(['Ngày', 'Thu', 'Chi', 'Số phiếu', 'Đơn vị']);
    expect(sheet.rows[0]).toEqual([new Date('2026-11-01T00:00:00Z'), 2500000000, -1500000000, 4, 'VND']);
    expect(sheet.rows[1]).toEqual([new Date('2026-11-02T00:00:00Z'), 1000000000, 250000000, 2, 'VND']);
    // không ô nào là object → không còn JSON WireAmount
    for (const r of sheet.rows) for (const v of r) expect(v === null || typeof v === 'string' || typeof v === 'number' || v instanceof Date).toBe(true);
    // cột tiền mang format số, KHÔNG có dòng TỔNG thừa
    expect(sheet.columns[1]?.numFmt).toBe('#,##0');
    expect(sheet.rows.map((r) => r.length)).toEqual([5, 5]);
  });

  it('báo cáo 6 cột tiền một loại tiền → 7 cột, không phải 12 cột', () => {
    const cols = ['income', 'expense', 'net', 'receivable', 'payable', 'loan_outstanding'].map((k) => col(k, k.toUpperCase(), 'compact'));
    const sheet = buildExportSheet(cols, [{ income: wire('1'), expense: wire('2'), net: wire('3'), receivable: wire('4'), payable: wire('5'), loan_outstanding: wire('6') }]);
    expect(sheet.columns).toHaveLength(7);
    expect(sheet.columns[6]!.header).toBe('Đơn vị');
    expect(sheet.rows[0]).toEqual([1, 2, 3, 4, 5, 6, 'VND']);
  });

  it('lẫn nhiều loại tiền → cột "… — đơn vị" riêng ngay sau từng cột tiền (ô "Đơn vị" chung sẽ mô tả sai)', () => {
    const sheet = buildExportSheet([col('balance', 'Số dư', 'compact'), col('projected', 'Dự kiến', 'compact')], [
      { balance: wire('123456', 'USD'), projected: wire('100000', 'USD') },
      { balance: wire('900000000', 'VND'), projected: wire('90000000', 'VND') },
    ]);
    expect(sheet.columns.map((c) => c.header)).toEqual(['Số dư', 'Số dư — đơn vị', 'Dự kiến', 'Dự kiến — đơn vị']);
    expect(sheet.rows[0]).toEqual([1234.56, 'USD', 1000, 'USD']);
    expect(sheet.rows[1]).toEqual([900000000, 'VND', 90000000, 'VND']);
  });

  it('USD/EUR: 2 chữ số thập phân theo MÃ TIỀN (wire().decimals luôn 0 → từng bị xuất to gấp 100 lần)', () => {
    const sheet = buildExportSheet([col('balance', 'Số dư', 'compact')], [{ balance: wire('123456', 'USD', 0) }]);
    expect(sheet.columns[0]!.numFmt).toBe('#,##0.00');
    expect(sheet.rows[0]).toEqual([1234.56, 'USD']);
  });

  it('không có ô tiền nào → không thêm cột "Đơn vị"', () => {
    const sheet = buildExportSheet([col('user_name', 'Người xử lý', 'text'), col('decisions', 'Số quyết định', 'number')], [{ user_name: 'A', decisions: 12 }]);
    expect(sheet.columns.map((c) => c.header)).toEqual(['Người xử lý', 'Số quyết định']);
    expect(sheet.rows[0]).toEqual(['A', 12]);
  });

  it('cột có `unit` (lãi suất lưu chuỗi "9,5") → số + cột đơn vị riêng, không cộng gộp với tiền', () => {
    const sheet = buildExportSheet(
      [col('contract_code', 'Mã khoản', 'text'), { ...col('interest_rate', 'Lãi suất', 'text'), unit: '%/năm' }, col('outstanding', 'Dư nợ', 'compact')],
      [
        { contract_code: 'VAY-001', interest_rate: '9,5', outstanding: wire('5000000000') },
        { contract_code: 'VAY-002', interest_rate: '8.5', outstanding: wire('1500000000') },
        { contract_code: 'VAY-003', interest_rate: '', outstanding: wire('100000000') },
      ],
    );
    expect(sheet.columns.map((c) => c.header)).toEqual(['Mã khoản', 'Lãi suất', 'Lãi suất — đơn vị', 'Dư nợ', 'Đơn vị']);
    expect(sheet.rows[0]).toEqual(['VAY-001', 9.5, '%/năm', 5000000000, 'VND']);
    expect(sheet.rows[1]![1]).toBe(8.5);
    expect(sheet.rows[2]![1]).toBe(''); // không có lãi suất → không bịa số, không ghi đơn vị
    expect(sheet.rows[2]![2]).toBe('');
  });

  it('làm phẳng giá trị rác: boolean → Có/Không, object lạ → không phải JSON', () => {
    const sheet = buildExportSheet(
      [col('breach', 'Vi phạm', 'status', 'center'), col('sla_percent', 'Đúng SLA', 'percent', 'right'), col('note', 'Ghi chú', 'text')],
      [{ breach: true, sla_percent: 87.5, note: { weird: 1 } }],
    );
    expect(sheet.rows[0]).toEqual(['Có', 87.5, '']);
    expect(sheet.rows[0]!.join('|')).not.toContain('weird');
  });

  it('cột text chỉ gồm chữ số (Số TK, MST) KHÔNG biến thành số — giữ số 0 đầu, không thành mũ khoa học', () => {
    const sheet = buildExportSheet(
      [col('bank_name', 'Ngân hàng', 'text'), col('account', 'Số TK', 'text'), col('breach', 'Vi phạm', 'status', 'center'), col('balance', 'Số dư', 'compact')],
      [
        { bank_name: 'BIDV', account: '0011000566003', breach: false, balance: wire('925000000') },
        { bank_name: 'VCB', account: '0987654321', breach: true, balance: wire('100000', 'VND') },
      ],
    );
    expect(typeof sheet.rows[0]![1]).toBe('string');
    expect(sheet.rows[0]![1]).toBe('0011000566003');
    expect(sheet.rows[0]![2]).toBe('Không');
    expect(sheet.rows[1]![2]).toBe('Có');
    // cùng một loại tiền → một cột Đơn vị chung
    expect(sheet.rows.map((r) => r[4])).toEqual(['VND', 'VND']);
  });

  it('tiền null/rỗng → ô số TRỐNG (không bịa 0), cột Đơn vị vẫn ghi mã tiền chung', () => {
    const sheet = buildExportSheet([col('amount', 'Số tiền', 'money')], [{ amount: null }, { amount: wire('7000') }]);
    expect(sheet.rows[0]).toEqual(['', 'VND']);
    expect(sheet.rows[1]).toEqual([7000, 'VND']);
  });

  it('nhận cả BigInt, bson Long và số nguyên minor', () => {
    const sheet = buildExportSheet([col('amount', 'Số tiền', 'compact')], [
      { amount: 5_000_000n },
      { amount: { low: 1, high: 0, toString: () => '4294967297' } },
      { amount: '800000' },
      { amount: 900000 },
    ]);
    expect(sheet.rows.map((r) => r[0])).toEqual([5000000, 4294967297, 800000, 900000]);
  });

  it('không có dòng nào → chỉ có cột, khong có dòng dữ liệu', () => {
    const sheet = buildExportSheet([col('amount', 'Số tiền', 'compact')], []);
    expect(sheet.rows).toEqual([]);
    expect(sheet.columns).toHaveLength(1); // không có tiền → không thêm cột đơn vị
  });
});

describe('scaleMinor / sheetNameOf / colLetter', () => {
  it('scaleMinor giữ đúng dấu và chữ số thập phân', () => {
    expect(scaleMinor(-123456n, 2)).toBe(-1234.56);
    expect(scaleMinor(5n, 2)).toBe(0.05);
    expect(scaleMinor(0n, 0)).toBe(0);
    expect(scaleMinor(123456789012345n, 0)).toBe(123456789012345);
  });

  it('tên sheet chặn ký tự cấm và ≤31 ký tự', () => {
    expect(sheetNameOf('Sổ chi tiết / đối tác [ABC]')).toBe('Sổ chi tiết · đối tác ·ABC·');
    expect(sheetNameOf(''.padEnd(50, 'x'))).toHaveLength(31);
    expect(sheetNameOf('')).toBe('Bieu mau');
  });

  it('colLetter: 1→A, 26→Z, 27→AA', () => {
    expect([colLetter(1), colLetter(26), colLetter(27), colLetter(0)]).toEqual(['A', 'Z', 'AA', 'A']);
  });
});

describe('writeXlsx — file thật đọc lại phải là SỐ (không phải text/JSON)', () => {
  it('ô tiền kiểu Number + numFmt, cột Đơn vị riêng, header đậm + freeze + autoFilter, không có dòng TỔNG', async () => {
    const sheet = buildExportSheet(
      [col('date', 'Ngày', 'date'), col('income', 'Thu', 'compact'), col('expense', 'Chi', 'compact')],
      [
        { date: '2026-11-01', income: wire('2500000000'), expense: wire('-1500000000') },
        { date: '2026-11-02', income: wire('1000000000'), expense: wire('250000000') },
      ],
    );
    const tmp = join(tmpdir(), `fingate-export-${process.pid}-${Date.now()}.xlsx`);
    try {
      await new Promise<void>((resolve, reject) => {
        const sink = createWriteStream(tmp);
        sink.on('error', reject);
        sink.on('close', resolve);
        void writeXlsx(sheet, sink, { sheetName: 'Thu – chi ngày', watermark: 'Xuất bởi Tester · 18/11/2026 · Tất cả công ty' }).catch(reject);
      });

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(tmp);
      const ws = wb.worksheets[0]!;

      expect(ws.name).toBe('Thu – chi ngày');
      expect(ws.getRow(1).getCell(1).text).toBe('Ngày');
      expect(ws.getRow(1).getCell(2).text).toBe('Thu');
      expect(ws.getRow(1).getCell(4).text).toBe('Đơn vị');
      expect(ws.getRow(1).getCell(2).font.bold).toBe(true);

      const money = ws.getRow(2).getCell(2);
      expect(typeof money.value).toBe('number');
      expect(money.value).toBe(2500000000);
      expect(money.numFmt).toBe('#,##0');
      expect(ws.getRow(2).getCell(3).value).toBe(-1500000000);
      expect(ws.getRow(2).getCell(4).text).toBe('VND');
      expect(ws.getRow(2).getCell(1).value instanceof Date).toBe(true);

      // không có dòng TỔNG → watermark nằm ngay sau 2 dòng dữ liệu
      expect(ws.getRow(3).getCell(1).value instanceof Date).toBe(true);
      expect(ws.getRow(4).getCell(1).text).toContain('Xuất bởi');
      // autoFilter phủ đúng vùng dữ liệu, không gồm watermark (exceljs đọc lại nguyên chuỗi ref)
      expect(String(ws.autoFilter)).toBe('A1:D3');
      expect(ws.views[0]?.state).toBe('frozen');
    } finally {
      await rm(tmp, { force: true });
    }
  });
});

describe('toCsv — số dùng dấu phẩy thập phân, phân cách ; (Excel vi-VN)', () => {
  it('ra đúng: ô tiền là số, đơn vị cột riêng, có BOM, không có dòng TỔNG', () => {
    const sheet = buildExportSheet([col('amount', 'Số tiền', 'compact')], [
      { amount: wire('2500000000') },
      { amount: wire('1000000000') },
    ]);
    const csv = toCsv(sheet, 'Xuất bởi Tester');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Số tiền;Đơn vị');
    expect(lines[1]).toBe('2500000000;VND');
    expect(lines[2]).toBe('1000000000;VND');
    expect(lines[3]).toBe('Xuất bởi Tester');
    expect(lines).toHaveLength(4);
  });

  it('USD → dấu phẩy thập phân 2 chữ số để Excel VN đọc ra SỐ', () => {
    const sheet = buildExportSheet([col('balance', 'Số dư', 'compact')], [{ balance: wire('123456', 'USD') }]);
    expect(toCsv(sheet).slice(1).trim().split('\r\n')[1]).toBe('1234,56;USD');
  });
});
