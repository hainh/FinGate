/**
 * FinGate — mã lỗi (architecture §16, §6)
 *
 * Mọi lỗi API trả về `application/problem+json` với `code` có trong danh mục này.
 * Message tiếng Việt thân thiện, không lộ stack, không lộ thông tin người dùng khác.
 * FE map code → hành động (refetch, mở màn hình, ẩn CTA…).
 */

export type ProblemCode =
  // --- phiên & quyền ---
  | 'FG-AUTH-001' // chưa đăng nhập / session hết hạn
  | 'FG-AUTH-002' // sai email hoặc mật khẩu (thông điệp duy nhất, chống dò)
  | 'FG-AUTH-003' // tài khoản chưa kích hoạt
  | 'FG-AUTH-004' // tài khoản đã ngừng hoạt động
  | 'FG-AUTH-005' // cần 2FA
  | 'FG-AUTH-006' // OTP sai hoặc đã dùng
  | 'FG-AUTH-007' // tạm khoá vì đăng nhập sai nhiều lần
  | 'FG-AUTH-008' // step-up verify thất bại (mật khẩu/OTP khi hành động nhạy cảm)
  | 'FG-AUTH-009' // token mời hết hạn hoặc đã dùng
  // --- phân quyền / phạm vi ---
  | 'FG-RBAC-001' // không có quyền thực hiện hành động
  | 'FG-RBAC-002' // hồ sơ ngoài phạm vi công ty
  | 'FG-RBAC-011' // không có quyền xuất dữ liệu
  | 'FG-RBAC-012' // vượt hạn mức duyệt của người dùng
  // --- workflow ---
  | 'FG-WF-001' // hành động không hợp lệ với trạng thái hiện tại
  | 'FG-WF-002' // người dùng không phải cấp duyệt hiện tại
  | 'FG-WF-003' // thiếu chứng từ bắt buộc
  | 'FG-WF-004' // thiếu ý kiến / lý do bắt buộc
  | 'FG-WF-005' // hồ sơ đã khóa (đã qua cấp)
  | 'FG-WF-006' // không tìm thấy ma trận duyệt phù hợp
  | 'FG-WF-007' // ngân sách/kế hoạch vượt ngưỡng, cần xác nhận
  | 'FG-WF-008' // thiếu trường bắt buộc của loại phiếu
  | 'FG-WF-009' // không được tự duyệt hồ sơ mình tạo
  | 'FG-WF-010' // số dư khả dụng không đủ
  | 'FG-WF-011' // xung đột phiên bản (CAS) — hồ sơ đã bị người khác thay đổi
  | 'FG-WF-012' // trùng request_id (đã xử lý)
  // --- dữ liệu ---
  | 'FG-VAL-001' // dữ liệu không hợp lệ
  | 'FG-VAL-002' // định dạng file không được hỗ trợ
  | 'FG-VAL-003' // file vượt dung lượng
  | 'FG-VAL-004' // vượt hạn mức dung lượng công ty
  | 'FG-VAL-005' // sha256/kích thước không khớp khi confirm
  // --- nhân sự ---
  | 'FG-HR-001' // email đã tồn tại trong hệ thống
  | 'FG-HR-002' // không có quyền quản lý nhân sự công ty này
  | 'FG-HR-003' // nhân sự đang giữ hồ sơ chờ duyệt — cần chỉ định người thay thế
  // --- hệ thống ---
  | 'FG-SYS-001' // lỗi hệ thống
  | 'FG-SYS-002' // dịch vụ đang bảo trì
  | 'FG-SYS-003' // nguồn dữ liệu chưa đồng bộ (partial)
  | 'FG-SYS-004' // vượt giới hạn dòng xuất dữ liệu
  | 'FG-TASK-001'; // x-task-token không hợp lệ

export interface ProblemDef {
  code: ProblemCode;
  status: number;
  titleVi: string;
  /** Hành động khuyến nghị cho FE. */
  hint?: 'refetch' | 'retry' | 'auth' | 'scope' | 'contact_admin' | 'none';
}

export const PROBLEM_CATALOG: Record<ProblemCode, ProblemDef> = {
  'FG-AUTH-001': { code: 'FG-AUTH-001', status: 401, titleVi: 'Phiên làm việc đã kết thúc', hint: 'auth' },
  'FG-AUTH-002': { code: 'FG-AUTH-002', status: 401, titleVi: 'Email hoặc mật khẩu không đúng', hint: 'none' },
  'FG-AUTH-003': { code: 'FG-AUTH-003', status: 403, titleVi: 'Tài khoản chưa được kích hoạt', hint: 'contact_admin' },
  'FG-AUTH-004': { code: 'FG-AUTH-004', status: 403, titleVi: 'Tài khoản đã ngừng hoạt động', hint: 'contact_admin' },
  'FG-AUTH-005': { code: 'FG-AUTH-005', status: 401, titleVi: 'Cần xác thực 2 lớp', hint: 'auth' },
  'FG-AUTH-006': { code: 'FG-AUTH-006', status: 401, titleVi: 'Mã OTP không đúng hoặc đã hết hiệu lực', hint: 'retry' },
  'FG-AUTH-007': { code: 'FG-AUTH-007', status: 429, titleVi: 'Bạn đã nhập sai nhiều lần. Thử lại sau 15 phút.', hint: 'retry' },
  'FG-AUTH-008': { code: 'FG-AUTH-008', status: 403, titleVi: 'Xác thực lại thất bại', hint: 'retry' },
  'FG-AUTH-009': { code: 'FG-AUTH-009', status: 410, titleVi: 'Liên kết kích hoạt không còn hiệu lực', hint: 'contact_admin' },

  'FG-RBAC-001': { code: 'FG-RBAC-001', status: 403, titleVi: 'Bạn không có quyền thực hiện việc này', hint: 'none' },
  'FG-RBAC-002': { code: 'FG-RBAC-002', status: 403, titleVi: 'Hồ sơ ngoài phạm vi dữ liệu của bạn', hint: 'scope' },
  'FG-RBAC-011': { code: 'FG-RBAC-011', status: 403, titleVi: 'Bạn không có quyền xuất dữ liệu này', hint: 'none' },
  'FG-RBAC-012': { code: 'FG-RBAC-012', status: 403, titleVi: 'Khoản này vượt hạn mức duyệt của bạn', hint: 'none' },

  'FG-WF-001': { code: 'FG-WF-001', status: 422, titleVi: 'Hành động không hợp lệ với trạng thái hiện tại', hint: 'refetch' },
  'FG-WF-002': { code: 'FG-WF-002', status: 403, titleVi: 'Hồ sơ không thuộc bàn của bạn', hint: 'refetch' },
  'FG-WF-003': { code: 'FG-WF-003', status: 422, titleVi: 'Hồ sơ thiếu chứng từ bắt buộc', hint: 'none' },
  'FG-WF-004': { code: 'FG-WF-004', status: 422, titleVi: 'Cần nhập ý kiến cho hành động này', hint: 'none' },
  'FG-WF-005': { code: 'FG-WF-005', status: 422, titleVi: 'Hồ sơ đã qua cấp duyệt, không sửa được nữa', hint: 'refetch' },
  'FG-WF-006': { code: 'FG-WF-006', status: 422, titleVi: 'Chưa cấu hình quy trình duyệt cho khoản này', hint: 'contact_admin' },
  'FG-WF-007': { code: 'FG-WF-007', status: 422, titleVi: 'Khoản ngoài ngân sách — cần xác nhận', hint: 'none' },
  'FG-WF-008': { code: 'FG-WF-008', status: 422, titleVi: 'Thiếu trường bắt buộc của loại phiếu', hint: 'none' },
  'FG-WF-009': { code: 'FG-WF-009', status: 403, titleVi: 'Không được tự duyệt hồ sơ mình tạo', hint: 'none' },
  'FG-WF-010': { code: 'FG-WF-010', status: 422, titleVi: 'Số dư khả dụng không đủ', hint: 'none' },
  'FG-WF-011': { code: 'FG-WF-011', status: 409, titleVi: 'Hồ sơ đã được người khác cập nhật', hint: 'refetch' },
  'FG-WF-012': { code: 'FG-WF-012', status: 200, titleVi: 'Yêu cầu đã được xử lý trước đó', hint: 'refetch' },

  'FG-VAL-001': { code: 'FG-VAL-001', status: 422, titleVi: 'Dữ liệu không hợp lệ', hint: 'none' },
  'FG-VAL-002': { code: 'FG-VAL-002', status: 422, titleVi: 'Định dạng file không được hỗ trợ', hint: 'none' },
  'FG-VAL-003': { code: 'FG-VAL-003', status: 413, titleVi: 'File vượt dung lượng cho phép', hint: 'none' },
  'FG-VAL-004': { code: 'FG-VAL-004', status: 422, titleVi: 'Vượt hạn mức dung lượng lưu trữ của công ty', hint: 'none' },
  'FG-VAL-005': { code: 'FG-VAL-005', status: 422, titleVi: 'File tải lên không khớp thông tin đã khai', hint: 'retry' },

  'FG-HR-001': { code: 'FG-HR-001', status: 409, titleVi: 'Email đã có trong hệ thống', hint: 'none' },
  'FG-HR-002': { code: 'FG-HR-002', status: 403, titleVi: 'Bạn không quản lý nhân sự công ty này', hint: 'none' },
  'FG-HR-003': { code: 'FG-HR-003', status: 409, titleVi: 'Người này đang giữ hồ sơ chờ duyệt', hint: 'none' },

  'FG-SYS-001': { code: 'FG-SYS-001', status: 500, titleVi: 'Hệ thống đang gặp sự cố. Vui lòng thử lại.', hint: 'retry' },
  'FG-SYS-002': { code: 'FG-SYS-002', status: 503, titleVi: 'Hệ thống đang bảo trì', hint: 'retry' },
  'FG-SYS-003': { code: 'FG-SYS-003', status: 200, titleVi: 'Một phần dữ liệu chưa đồng bộ', hint: 'refetch' },
  'FG-SYS-004': { code: 'FG-SYS-004', status: 422, titleVi: 'Vượt giới hạn dòng xuất dữ liệu', hint: 'none' },
  'FG-TASK-001': { code: 'FG-TASK-001', status: 403, titleVi: 'Không thể khởi tạo công việc', hint: 'none' },
};

/** Envelope chuẩn RFC 7807 + code FinGate + trace_id (architecture §6). */
export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  trace_id?: string;
  /** field → thông điệp, cho validate inline (DS §7.5). */
  errors?: Record<string, string>;
  /** dữ liệu phụ cho UI (ví dụ hạn mức, người vừa duyệt lúc nào). */
  data?: Record<string, unknown>;
}

export interface ProblemInput {
  code: ProblemCode;
  detail?: string;
  errors?: Record<string, string>;
  data?: Record<string, unknown>;
  traceId?: string;
  status?: number;
}

export class ApiError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail?: string;
  readonly errors?: Record<string, string>;
  readonly data?: Record<string, unknown>;

  constructor(input: ProblemInput) {
    const def = PROBLEM_CATALOG[input.code];
    super(def.titleVi);
    this.name = 'ApiError';
    this.code = input.code;
    this.status = input.status ?? def.status;
    this.detail = input.detail;
    this.errors = input.errors;
    this.data = input.data;
  }

  toProblem(traceId?: string): ProblemJson {
    return toProblem(this, traceId ?? this.data?.['trace_id'] as string | undefined);
  }
}

export function apiError(code: ProblemCode, extra: Omit<ProblemInput, 'code'> = {}): ApiError {
  return new ApiError({ code, ...extra });
}

export function toProblem(err: ApiError, traceId?: string): ProblemJson {
  const problem: ProblemJson = {
    type: `https://fingate.local/errors/${err.code.toLowerCase()}`,
    title: PROBLEM_CATALOG[err.code].titleVi,
    status: err.status,
    code: err.code,
  };
  if (err.detail) problem.detail = err.detail;
  if (err.errors) problem.errors = err.errors;
  if (err.data) problem.data = err.data;
  if (traceId) problem.trace_id = traceId;
  return problem;
}

/** Parse lỗi từ API (FE) — trả problem hợp lệ nhất có thể. */
export function parseProblem(status: number, body: unknown): ProblemJson {
  if (body && typeof body === 'object' && 'code' in body) {
    const b = body as Partial<ProblemJson>;
    const code = (b.code as ProblemCode) in PROBLEM_CATALOG ? (b.code as ProblemCode) : 'FG-SYS-001';
    const def = PROBLEM_CATALOG[code];
    return {
      type: b.type ?? def.titleVi,
      title: b.title ?? def.titleVi,
      status: b.status ?? status,
      code,
      detail: b.detail,
      errors: b.errors,
      data: b.data,
      trace_id: b.trace_id,
    };
  }
  const fallback: ProblemCode = status === 401 ? 'FG-AUTH-001' : status === 403 ? 'FG-RBAC-001' : 'FG-SYS-001';
  const def = PROBLEM_CATALOG[fallback];
  return { type: def.titleVi, title: def.titleVi, status, code: fallback };
}

export function problemHint(code: ProblemCode): ProblemDef['hint'] {
  return PROBLEM_CATALOG[code].hint ?? 'none';
}
