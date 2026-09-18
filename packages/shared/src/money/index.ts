/**
 * FinGate — tiền tệ & định dạng (Design System §4, architecture §8.5)
 *
 * Luật cứng (§19.5-1): tiền là số nguyên minor units, tính bằng BigInt.
 * Trên wire là STRING ("2500000000"). Cấm `Number` arithmetic / `parseFloat` /
 * `toFixed` cho tiền ở mọi tầng — mọi output số đi qua hàm ở file này
 * (UI · Excel export · email dùng chung một nguồn).
 */

export type Currency = 'VND' | 'USD' | 'EUR' | 'JPY' | 'CNY';

export interface CurrencyDef {
  code: Currency;
  symbol: string;
  /** Số chữ số thập phân của đơn vị tiền tệ (VND: 0 — đồng là minor unit). */
  decimals: number;
  labelVi: string;
}

export const CURRENCIES: Record<Currency, CurrencyDef> = {
  VND: { code: 'VND', symbol: '₫', decimals: 0, labelVi: 'đồng Việt Nam' },
  USD: { code: 'USD', symbol: '$', decimals: 2, labelVi: 'đô la Mỹ' },
  EUR: { code: 'EUR', symbol: '€', decimals: 2, labelVi: 'euro' },
  JPY: { code: 'JPY', symbol: '¥', decimals: 0, labelVi: 'yên Nhật' },
  CNY: { code: 'CNY', symbol: '¥', decimals: 2, labelVi: 'NDT' },
};

export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];

export function currencyDecimals(code: string | undefined): number {
  return CURRENCIES[(code ?? 'VND').toUpperCase() as Currency]?.decimals ?? 0;
}

export function isCurrency(v: unknown): v is Currency {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, v.toUpperCase());
}

export function asCurrency(v: string | undefined): Currency {
  const code = (v ?? 'VND').toUpperCase();
  return isCurrency(code) ? (code as Currency) : 'VND';
}

/* ------------------------------------------------------------------ *
 * Money — minor units là bigint
 * ------------------------------------------------------------------ */

export interface Money {
  minor: bigint;
  currency: Currency;
  decimals: number;
}

export function money(
  input: bigint | string | number | { minor: unknown; currency?: string; decimals?: number },
  currency?: string,
): Money {
  let raw: unknown;
  let cur = currency;
  if (typeof input === 'object' && input !== null && 'minor' in input) {
    raw = input.minor;
    cur = cur ?? input.currency;
  } else {
    raw = input;
  }
  let minor: bigint;
  if (typeof raw === 'bigint') {
    minor = raw;
  } else if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new TypeError('Tiền phải là số nguyên minor units — cấm float');
    }
    minor = BigInt(raw);
  } else if (typeof raw === 'string') {
    const t = raw.trim();
    if (!/^-?\d+$/.test(t)) throw new TypeError(`Minor units phải là chuỗi số nguyên: "${raw}"`);
    minor = BigInt(t);
  } else {
    throw new TypeError('Giá trị tiền không hợp lệ');
  }
  const code = asCurrency(cur);
  return { minor, currency: code, decimals: currencyDecimals(code) };
}

export const ZERO = (currency: Currency = 'VND'): Money => money(0n, currency);
export const toMinor = (v: bigint | string | number): bigint => money(v).minor;

/** Wire format — mọi API trả về dùng hàm này (Long → string). */
export function moneyToWire(m: Money): { minor: string; currency: string; decimals: number } {
  return { minor: m.minor.toString(), currency: m.currency, decimals: m.decimals };
}

export function moneyFromWire(v: { minor: unknown; currency?: string; decimals?: number } | null | undefined): Money | null {
  if (!v || v.minor === null || v.minor === undefined) return null;
  return money(v as { minor: unknown; currency?: string });
}

export function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Không cộng/trừ khác loại tiền (${a.currency} vs ${b.currency}) — quy đổi qua fx trước`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { ...a, minor: a.minor + b.minor };
}

export function sub(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { ...a, minor: a.minor - b.minor };
}

export const neg = (a: Money): Money => ({ ...a, minor: -a.minor });
export const abs = (m: Money): Money => (m.minor < 0n ? { ...m, minor: -m.minor } : m);
export const isZero = (m: Money): boolean => m.minor === 0n;
export const isNegative = (m: Money): boolean => m.minor < 0n;
export const isPositive = (m: Money): boolean => m.minor > 0n;

export function sum(list: readonly Money[], currency: Currency = 'VND'): Money {
  let acc = 0n;
  for (const m of list) {
    if (m.currency !== currency) sameCurrency(m, ZERO(currency));
    acc += m.minor;
  }
  return money(acc, currency);
}

export function sumMinor(list: readonly bigint[], currency: Currency = 'VND'): Money {
  return money(list.reduce((a, b) => a + b, 0n), currency);
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function gte(a: Money, b: Money): boolean {
  sameCurrency(a, b);
  return a.minor >= b.minor;
}

export function lt(a: Money, b: Money): boolean {
  sameCurrency(a, b);
  return a.minor < b.minor;
}

/* ------------------------------------------------------------------ *
 * Tỷ giá — Decimal128 trên DB, chuỗi ở tầng ứng dụng (arch §8.5)
 * ------------------------------------------------------------------ */

/** Chia số nguyên làm tròn half-up, không dùng float. */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError('Chia cho 0');
  const negative = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = n / d;
  const r = n % d;
  const out = r * 2n >= d ? q + 1n : q;
  return negative ? -out : out;
}

/** "12,5" → { num: 125n, scale: 1 } */
function parseDecimalString(value: string): { num: bigint; scale: number } {
  const clean = value.trim().replace(/\s+/g, '').replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(clean);
  if (!m) throw new TypeError(`Tỷ giá/số thập phân không hợp lệ: "${value}"`);
  const [, sign, int, frac = ''] = m;
  return { num: BigInt(`${sign === '-' ? '-' : ''}${int}${frac}`), scale: frac.length };
}

/**
 * Quy đổi theo tỷ giá snapshot tại ngày phiếu (rate = số nội tệ / 1 ngoại tệ,
 * ví dụ 26310.50). Làm tròn về minor unit của đồng đích.
 */
export function convert(m: Money, rate: string | number, to: Currency): Money {
  const r = parseDecimalString(String(rate));
  const fromDec = BigInt(m.decimals);
  const toDec = BigInt(currencyDecimals(to));
  // major(to) = major(from) * 1 / rate  →  minor(to) = minor(from) * 10^toDec * 10^r.scale / (10^fromDec * 10^r.numDigits...)
  const minor = divRound(m.minor * r.num * 10n ** toDec, 10n ** fromDec * 10n ** BigInt(r.scale));
  return { minor, currency: to, decimals: Number(toDec) };
}

export function percentOf(m: Money, percent: number | string): Money {
  const p = parseDecimalString(String(percent));
  return { ...m, minor: divRound(m.minor * p.num, 10n ** BigInt(p.scale + 2)) };
}

/** part / total × 100, trả số thực CHỈ để hiển thị (`+8,4%`) — không dùng để tính tiền. */
export function ratioOf(part: Money, total: Money): number {
  sameCurrency(part, total);
  if (total.minor === 0n) return 0;
  return Number(divRound(part.minor * 10000n, total.minor)) / 100;
}

/* ------------------------------------------------------------------ *
 * Format vi-VN (DS §4.1)
 * ------------------------------------------------------------------ */

export const MINUS = '\u2212'; // − U+2212
export const MISSING = '\u2014'; // — = chưa có dữ liệu (khác `0 ₫`)
const NBSP = '\u00a0';

const nf0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
function nf(d: number): Intl.NumberFormat {
  return new Intl.NumberFormat('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export type MoneyMode = 'full' | 'compact' | 'kpi';

export interface FormatMoneyOptions {
  mode?: MoneyMode;
  signed?: boolean;
  /** compact cho ngoại tệ: hiện mã tiền tệ. Mặc định true. */
  showCurrency?: boolean;
  /** Ép số chữ số thập phân ở chế độ compact. */
  precision?: number;
}

const MILLION = 1_000_000n;
const BILLION = 1_000_000_000n;
const THOUSAND_BILLION = 1_000_000_000_000n;

/** Giá trị lớn (major units) dưới dạng chuỗi phân nhóm, có dấu thập phân nếu cần. */
function formatMajor(minor: bigint, decimals: number, fracDigits: number): string {
  const factor = 10n ** BigInt(decimals);
  const intPart = minor / factor;
  const fracPart = minor % factor;
  if (decimals === 0 || fracPart === 0n) {
    if (fracDigits > 0) return `${nf0.format(intPart)},${'0'.repeat(fracDigits)}`;
    return nf0.format(intPart);
  }
  const frac = fracPart.toString().padStart(decimals, '0');
  const shown = fracDigits > 0 ? frac.padEnd(fracDigits, '0').slice(0, fracDigits) : frac.replace(/0+$/, '');
  return `${nf0.format(intPart)},${shown}`;
}

/**
 * `full`    → `2.500.000.000 ₫`  (chi tiết, phê duyệt, chứng từ, giá trị pháp lý)
 * `compact` → `2,50 tỷ` · `850 tr`
 * `kpi`     → `125,6 tỷ`         (≥ 100 tỷ: 1 chữ số thập phân)
 *
 * Số âm dùng `−` (U+2212). `< 1.000.000` → ₫ đầy đủ. Scale: tr · tỷ · nghìn tỷ.
 */
export function formatMoney(input: Money | bigint | string | number, opts: FormatMoneyOptions = {}): string {
  const m = isMoney(input) ? input : money(input as never);
  const mode = opts.mode ?? 'full';
  const negative = m.minor < 0n;
  const a = negative ? -m.minor : m.minor;
  const sign = negative && (opts.signed ?? true) ? MINUS : '';
  const def = CURRENCIES[m.currency];
  const showCur = opts.showCurrency ?? true;

  if (mode === 'full' || m.currency !== 'VND') {
    const suffix = m.currency === 'VND' ? `${NBSP}${def.symbol}` : `${NBSP}${m.currency}`;
    const body = formatMajor(a, m.decimals, m.decimals > 0 ? m.decimals : 0);
    return `${sign}${body}${showCur ? suffix : ''}`;
  }

  const precision = opts.precision ?? (mode === 'kpi' && a >= 100n * BILLION ? 1 : 2);
  if (a < MILLION) return `${sign}${nf0.format(a)}${NBSP}${def.symbol}`;
  // DS §4.1: `850 tr` (gọn) nhưng `2,50 tỷ` / `−4,00 tỷ` (luôn 2 chữ số để thẳng cột trong bảng)
  if (a < BILLION) return `${sign}${compactUnit(a, MILLION, precision, false)}${NBSP}tr`;
  if (a < THOUSAND_BILLION) return `${sign}${compactUnit(a, BILLION, precision, mode !== 'kpi')}${NBSP}tỷ`;
  return `${sign}${compactUnit(a, THOUSAND_BILLION, precision, mode !== 'kpi')}${NBSP}nghìn tỷ`;
}

/**
 * value / unit với `precision` chữ số.
 * `keepZeros` = giữ số 0 tận cùng (`−4,00 tỷ` — bảng cần thẳng cột); false/`kpi` = bỏ (`850 tr`, `125,6 tỷ`).
 */
function compactUnit(value: bigint, unit: bigint, precision: number, keepZeros: boolean): string {
  if (precision <= 0) return nf0.format(value / unit);
  const p = 10n ** BigInt(precision);
  const scaled = divRound(value * p, unit);
  const intPart = scaled / p;
  const frac = (scaled % p).toString().padStart(precision, '0');
  if (/^0+$/.test(frac)) return keepZeros ? `${nf0.format(intPart)},${frac}` : nf0.format(intPart);
  if (!keepZeros) return `${nf0.format(intPart)},${frac.replace(/0+$/, '')}`;
  return `${nf0.format(intPart)},${frac}`;
}

export function isMoney(v: unknown): v is Money {
  return typeof v === 'object' && v !== null && 'minor' in v && 'currency' in v && 'decimals' in v;
}

/** `—` cho null/undefined — phân biệt với `0 ₫` (DS §4.1). */
export function formatMoneyOrMissing(
  m: Money | null | undefined,
  opts?: FormatMoneyOptions,
  missing: string = MISSING,
): string {
  return m === null || m === undefined ? missing : formatMoney(m, opts);
}

/** Đọc cho screen reader: `2.500.000.000 đồng`. */
export function moneyAria(m: Money): string {
  const body = formatMajor(m.minor < 0n ? -m.minor : m.minor, m.decimals, 0);
  return `${m.minor < 0n ? 'âm ' : ''}${body} ${CURRENCIES[m.currency]?.labelVi ?? m.currency}`;
}

/**
 * Parse input người dùng / paste từ Excel (DS §7.6):
 * `2500000000` · `2.500.000.000` · `2,5 tỷ` · `850 tr` · `2,50 tỷ` · `−1,2 tỷ`.
 */
export function parseMoneyInput(text: string, currency: Currency = 'VND'): Money {
  const raw = text.trim();
  if (!raw) return money(0n, currency);
  const lower = raw.toLowerCase().replace(/\s+/g, '');
  const dec = currencyDecimals(currency);
  const unitMatch = /(nghìntỷ|nghìn tỷ|ty|tỷ|tr|trieu|triệu)$/.exec(lower);
  const numText = unitMatch ? lower.slice(0, lower.length - unitMatch[0].length) : lower;
  const normalized = numText.replace(/\u2212/g, '-').replace(/₫|\s/g, '');
  const parsed = parseDecimalString(normalizeViNumber(normalized).replace(/[^0-9.,-]/g, ''));
  const unitExp = moneyUnitExponent(unitMatch ? unitMatch[0] : '');
  const minorExp = BigInt(unitExp + dec);
  const value = divRound(parsed.num * 10n ** minorExp, 10n ** BigInt(parsed.scale));
  return { minor: value, currency, decimals: dec };
}

/**
 * vi-VN: `.` phân cách nghìn, `,` phân cách thập phân. Khi chỉ có MỘT loại dấu và không
 * theo nhóm 3 chữ số thì coi đó là dấu thập phân (dạng paste từ Excel `2.5`).
 */
export function normalizeViNumber(input: string): string {
  const s = input.trim();
  const groupsOf3 = /^-?\d{1,3}([.,]\d{3})+$/;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // dấu xuất hiện sau cùng mới là phân cách thập phân
    return s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '').replace('.', ',');
  }
  if (hasDot) return groupsOf3.test(s) ? s.replace(/\./g, '') : s;
  if (hasComma) return groupsOf3.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  return s;
}

/** Số mũ đơn vị: `850 tr` → 6, `2,5 tỷ` → 9, `1,2 nghìn tỷ` → 12. */
export function moneyUnitExponent(suffix: string): number {
  const s = suffix
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u0308\u0323\u0329]/g, '')
    .replace(/[^a-z]/g, '');
  if (s === 'tr' || s === 'trieu') return 6;
  if (s === 'ty') return 9;
  if (s === 'nghinty' || s === 'ngayty') return 12;
  return 0;
}

/** Giá trị gõ trong ô nhập tiền (phân nhóm nghìn theo vi-VN). */
export function moneyInputValue(m: Money): string {
  return nf0.format(m.minor);
}

/**
 * Chuỗi hiển thị trong ô nhập tiền NGAY KHI GÕ: nhóm nghìn cho chuỗi chỉ gồm chữ số
 * và dấu ngăn cách (`2500000000` → `2.500.000.000`, nối tiếp `2.500` + `0` → `25.000`).
 * Giữ nguyên văn khi có dấu thập phân `,` hoặc đơn vị (`2,5 tỷ`, `850 tr`) — không đổi nghĩa.
 */
export function formatMoneyTyping(text: string): string {
  const t = text.replace(/\u2212/g, '-').trim();
  if (!/\d/.test(t) || /[^\d.\s-]/.test(t)) return text;
  const digits = t.replace(/\D/g, '');
  if (digits.length > 30) return text;
  return `${t.startsWith('-') ? '-' : ''}${nf0.format(BigInt(digits))}`;
}

/* ------------------------------------------------------------------ *
 * Số · phần trăm · lãi suất (DS §4.3)
 * ------------------------------------------------------------------ */

export const num = (v: number | bigint): string => nf0.format(v);

/** `+8,4%` — delta luôn có dấu. */
export function pct(v: number, d = 1): string {
  const sign = v > 0 ? '+' : v < 0 ? MINUS : '';
  return `${sign}${(d === 0 ? nf0 : d === 2 ? nf(2) : nf(1)).format(Math.abs(v))}%`;
}

/** `9,50 %/năm`. */
export function rateLabel(v: string | number, d = 2): string {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return `${(d === 1 ? nf(1) : nf(2)).format(n)} %/năm`;
}

export const countUnit = (n: number, unitVi: string): string => `${nf0.format(n)} ${unitVi}`;

/* ------------------------------------------------------------------ *
 * Ngày giờ — ngày nghiệp vụ Asia/Ho_Chi_Minh ≠ `*_at` UTC (arch §16)
 * ------------------------------------------------------------------ */

export const VN_TZ = 'Asia/Ho_Chi_Minh';

const fmtYmd = new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHm = new Intl.DateTimeFormat('en-GB', { timeZone: VN_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtWd = new Intl.DateTimeFormat('en-GB', { timeZone: VN_TZ, weekday: 'short' });

const asDate = (at: Date | string | number): Date => (at instanceof Date ? at : new Date(at));

/** `YYYY-MM-DD` theo giờ Việt Nam. MÃ không được suy ngày bằng `getDate()`. */
export function vnDate(at: Date | string | number = new Date()): string {
  return fmtYmd.format(asDate(at));
}

export function vnTime(at: Date | string | number = new Date()): string {
  return fmtHm.format(asDate(at)).replace('.', '');
}

const WEEKDAY_VI: Record<string, string> = { Mon: 'T2', Tue: 'T3', Wed: 'T4', Thu: 'T5', Fri: 'T6', Sat: 'T7', Sun: 'CN' };

export function vnWeekday(at: Date | string | number): string {
  return WEEKDAY_VI[fmtWd.format(asDate(at))] ?? '';
}

/** `15/09/2026` */
export function ddmmyyyy(at: Date | string | number): string {
  const [y, m, d] = vnDate(at).split('-');
  return `${d}/${m}/${y}`;
}

/** `15/09` nếu cùng năm với `ref` (DS §4.3). */
export function shortDate(at: Date | string | number, ref: Date = new Date()): string {
  const iso = vnDate(at);
  const [y, m, d] = iso.split('-');
  return y === vnDate(ref).slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/** `08/09/2026 09:15` — dùng cho audit. */
export function dateTimeLabel(at: Date | string | number): string {
  return `${ddmmyyyy(at)} ${vnTime(at)}`;
}

/** `YYYY-MM-DDTHH:mm` theo giờ Việt Nam — mốc deadline của phiếu. */
export function vnDateTime(at: Date | string | number = new Date()): string {
  return `${vnDate(at)}T${vnTime(at)}`;
}

/* ---------------------- deadline phiếu (planned_date) ---------------------- */

/** Cắt phần ngày của mốc deadline `YYYY-MM-DDTHH:mm`. */
export const datePartOf = (planned: string): string => planned.slice(0, 10);

/** `YYYY-MM-DDT00:00` — biên dưới của một ngày nghiệp vụ. */
export const dayStartOf = (iso: string): string => `${iso.slice(0, 10)}T00:00`;

/** `YYYY-MM-DDT23:59` — biên trên của một ngày nghiệp vụ. */
export const dayEndOf = (iso: string): string => `${iso.slice(0, 10)}T23:59`;

/** Chuẩn hoá `YYYY-MM-DD` cũ thành `YYYY-MM-DDTHH:mm` (mặc định 00:00). */
export const normalizePlannedDate = (planned: string): string => (planned.length === 10 ? `${planned}T00:00` : planned);

/** Deadline đã qua chưa — so theo giờ:phút, giờ VN (so chuỗi vì lưu dạng wall-clock). */
export function isDeadlinePast(planned: string | null | undefined, nowRef: Date = new Date()): boolean {
  if (!planned) return false;
  const v = planned.length === 10 ? `${planned}T00:00` : planned;
  return v < vnDateTime(nowRef);
}

/** `18/09/2026 09:00` — nhãn deadline (đọc trực tiếp wall-clock, không đổi múi giờ). */
export function deadlineLabel(planned: string): string {
  const [d = '', t = '00:00'] = planned.split('T');
  const [y = '', m = '', dd = ''] = d.split('-');
  return `${dd}/${m}/${y} ${t}`;
}

/** `T2 08/09` cho bảng forecast. */
export function weekdayDate(at: Date | string | number): string {
  return `${vnWeekday(at)} ${shortDate(at)}`;
}

/** Số ngày giữ nguyên theo lịch VN (b - a). */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Số ngày từ hôm nay (VN) tới ngày nghiệp vụ `iso`; âm = đã qua. */
export function daysUntil(iso: string, from: Date = new Date()): number {
  return daysBetween(vnDate(from), iso);
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function monthRange(iso: string): { from: string; to: string } {
  const [y, m] = iso.split('-');
  const from = `${y}-${m}-01`;
  const last = new Date(Date.UTC(Number(y), Number(m) + 1, 0)).toISOString().slice(0, 10);
  return { from, to: last };
}

export const today = (): string => vnDate();
export const now = (): Date => new Date();

/** ISO tuần tự cho sort; ngày nghiệp vụ làm khóa. */
export function isBusinessDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/** `vừa xong / N phút trước / N giờ trước / hôm qua`, sau 48h → absolute (DS §4.3). */
export function relativeTime(at: Date | string | number, nowRef: Date = new Date()): string {
  const d = asDate(at);
  const mins = Math.floor((nowRef.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'hôm qua';
  if (days === 2) return 'hôm kia';
  return ddmmyyyy(d);
}

export const numberFormatter = nf0;
