/**
 * FinGate — ngôn ngữ UI tiếng Việt (Design System §11)
 *
 * Một nguồn cho nhãn dùng chung để API (thông báo/email), UI, Excel và notification
 * không lệch nhau. Viết hoa đầu câu, không TitleCase giữa câu, không dùng `!`.
 */

export const UI = {
  app: { name: 'FinGate', tagline: 'Điều hành dòng tiền & phê duyệt tài chính' },

  action: {
    approve: 'Duyệt',
    approveAmount: (compact: string) => `Duyệt khoản ${compact}`,
    reject: 'Từ chối',
    requestChanges: 'Yêu cầu bổ sung',
    fastTrack: 'Duyệt trước',
    submit: 'Gửi',
    saveDraft: 'Lưu nháp',
    create: 'Tạo đề nghị',
    edit: 'Sửa',
    remove: 'Xóa',
    cancel: 'Hủy',
    close: 'Đóng',
    back: 'Quay lại',
    view: 'Xem chi tiết',
    viewTable: 'Xem dạng bảng',
    print: 'In',
    exportExcel: 'Xuất Excel',
    exportPdf: 'Xuất PDF',
    copyLink: 'Sao chép liên kết',
    duplicate: 'Nhân bản',
    retry: 'Thử lại',
    refresh: 'Làm mới',
    clearFilters: 'Xóa lọc',
    saveView: 'Lưu view',
    columnChooser: 'Chọn cột',
    density: 'Mật độ',
    confirm: 'Xác nhận',
    pay: 'Thực hiện thanh toán',
    markPaid: 'Ghi nhận đã thanh toán',
    urge: 'Đôn đốc',
    resendInvite: 'Gửi lại mời',
    deactivate: 'Ngừng hoạt động',
    invite: 'Mời nhân sự',
    upload: 'Tải lên',
    download: 'Tải về',
    acknowledge: 'Đã xử lý',
    seeAll: (n: number) => `Xem tất cả (${n})`,
  },

  status: {
    awaitingYou: 'Chờ bạn duyệt',
    awaitingRole: (role: string) => `Chờ ${role} duyệt`,
    waitingFor: (days: number) => `đã chờ ${days} ngày`,
    fastTrackedBy: (role: string) => `Đã duyệt trước bởi ${role}`,
    approvedBy: (name: string, at: string) => `${name} duyệt lúc ${at}`,
    rejectedBy: (name: string, at: string) => `${name} từ chối lúc ${at}`,
    skipped: 'Bỏ qua',
    canApproveNow: 'Có thể duyệt ngay',
    you: 'BẠN',
    opinion: 'Ý kiến',
    reason: 'Lý do',
    processApplied: (label: string) => `Quy trình áp dụng: ${label}`,
  },

  label: {
    company: 'Công ty',
    allCompanies: 'Tất cả công ty',
    department: 'Bộ phận',
    createdBy: 'Người lập',
    createdAt: 'Ngày tạo',
    kind: 'Loại phiếu',
    category: 'Danh mục',
    payee: 'Đối tượng',
    incomePayee: 'Khách hàng',
    expensePayee: 'Nhà cung cấp / người nhận',
    amount: 'Số tiền',
    currency: 'Loại tiền tệ',
    plannedDate: 'Ngày cần thanh toán',
    businessDate: 'Ngày nghiệp vụ',
    actualDate: 'Ngày thực hiện',
    status: 'Trạng thái',
    evidence: 'Chứng từ',
    missingEvidence: 'Chưa có chứng từ',
    source: 'Nguồn tiền',
    target: 'Tài khoản nhận',
    groupAccount: 'Tài khoản tập đoàn phụ trách',
    contract: 'Hợp đồng',
    invoice: 'Hóa đơn',
    note: 'Ghi chú',
    purpose: 'Nội dung',
    title: 'Tiêu đề',
    priority: 'Mức độ ưu tiên',
    budget: 'Ngân sách',
    inPlan: 'Trong kế hoạch',
    offPlan: 'Ngoài kế hoạch',
    outstanding: 'Dư nợ',
    limit: 'Hạn mức',
    maturityDate: 'Ngày đáo hạn',
    bank: 'Ngân hàng',
    accountNumber: 'Số tài khoản',
    accountName: 'Tên tài khoản',
    balance: 'Số dư',
    available: 'Khả dụng',
    blocked: 'Bị phong tỏa',
    opening: 'Đầu ngày',
    inflow: 'Tiền vào',
    outflow: 'Tiền ra',
    closing: 'Cuối ngày',
    net: 'Dòng tiền thuần',
    receivable: 'Phải thu',
    payable: 'Phải trả',
    settled: 'Đã thu/đã trả',
    remaining: 'Còn lại',
    dueDate: 'Hạn thanh toán',
    daysOverdue: 'Quá hạn',
    rate: 'Lãi suất',
    collateral: 'Tài sản bảo đảm',
    manager: 'Người phụ trách',
    user: 'Người dùng',
    role: 'Chức danh',
    lastLogin: 'Đăng nhập cuối',
    sla: 'SLA',
    waitingDays: 'Đã chờ',
    at: 'Lúc',
    ip: 'IP',
    device: 'Thiết bị',
    total: 'Tổng',
    asOf: (t: string) => `Cập nhật ${t}`,
    scopeAndDate: (scope: string, date: string) => `${scope} · ${date}`,
  },

  /** Dashboard 5 tầng (DS §8.1). */
  dashboard: {
    needAttention: 'Cần xử lý ngay',
    money: 'Tiền',
    cashflow: 'Dòng tiền',
    bankMaturity: 'Ngân hàng & đáo hạn',
    detail: 'Chi tiết',
    cashTotal: 'Tổng tiền hiện có',
    cashOnHand: 'Tiền mặt',
    cashBank: 'Tiền ngân hàng',
    cashRestricted: 'Bị hạn chế',
    incomeToday: 'Dự kiến thu hôm nay',
    spendToday: 'Cần chi hôm nay',
    awaitingMe: 'Chờ tôi duyệt',
    debtBalance: 'Dư nợ vay',
    maturityToday: 'Đáo hạn hôm nay',
    maturity7: 'Đáo hạn 7 ngày',
    maturity30: 'Đáo hạn 30 ngày',
    receivableOverdue: 'Khoản phải thu quá hạn',
    payableDue: 'Phải trả đến hạn',
    allClear: 'Không có khoản nào cần xử lý hôm nay',
    noData: 'Chưa có dữ liệu cho ngày hôm nay',
    partialSync: (name: string) => `Dữ liệu ${name} chưa đồng bộ`,
    serverWaking: 'Máy chủ đang thức dậy, vui lòng chờ…',
  },

  /** FgExceptionList — mỗi cảnh báo = vật + số + thời hạn + hành động (DS §11). */
  alert: {
    approvalOverdue: (n: number) => `${n} khoản chi đang chờ bạn duyệt`,
    rolloverPending: (n: number) => `${n} phương án đảo hạn đang chờ duyệt`,
    maturitySoon: (days: number) => `Đáo hạn trong ${days} ngày`,
    lowBalance: (account: string) => `Số dư ${account} dưới ngưỡng tối thiểu`,
    receivableOverdue: (n: number) => `${n} khoản phải thu quá hạn`,
    budgetExceeded: (label: string) => `Vượt ngân sách: ${label}`,
    missingEvidence: (code: string) => `Hồ sơ ${code} thiếu chứng từ`,
    cashflowNegative: (date: string) => `Dự kiến thiếu tiền ngày ${date}`,
    shortfall: (company: string, amount: string, date: string) =>
      `${company} có khả năng thiếu ${amount} vào ngày ${date}`,
  },

  /** v2 — đối tác (v2/v2.md §5). Không dùng "nhập tự do" / "chuỗi Tên - NH - STK" nữa. */
  partner: {
    title: 'Đối tác',
    create: 'Tạo đối tác',
    edit: 'Sửa đối tác',
    pick: 'Chọn đối tác',
    pickPlaceholder: 'Tìm theo tên, số tài khoản, MST…',
    addNew: (name: string) => `+ Tạo đối tác "${name}"`,
    none: 'Chưa chọn đối tác',
    duplicateWarning: (what: string) => `Trùng ${what} với đối tác khác trong công ty — vẫn có thể lưu`,
    duplicateName: 'tên',
    duplicateBankAccount: 'ngân hàng và số tài khoản',
    stopHint: 'Đối tác đã có phát sinh nên không xoá được — chỉ ngừng giao dịch',
    bankOnly: 'Chỉ chọn được đối tác Ngân hàng',
    copyFrom: 'Sao chép từ công ty khác',
    historyTitle: 'Lịch sử đối tác',
  },

  /** v2 — tag (v2/v2.md §6.2). */
  tag: {
    title: 'Tag',
    create: (name: string) => `+ Tạo tag "${name}"`,
    merge: 'Gộp tag',
    hide: 'Ẩn tag',
    hiddenNote: 'Tag đã ẩn không hiện khi gõ tìm, phiếu cũ vẫn giữ tag',
    separateFromCategory: 'Tag là nhãn tự do (dự án, công trình, đợt…); danh mục quyết định chứng từ và duyệt',
  },

  /** v2 — liên kết nghiệp vụ (v2/v2.md §11.2). */
  link: {
    title: 'Liên kết nghiệp vụ',
    removed: 'Đã gỡ liên kết',
    allocated: (amount: string) => `Đã phân bổ ${amount}`,
    remaining: (amount: string) => `Còn lại ${amount}`,
    autoBy: (rule: string) => `Tự động · ${rule}`,
    removeReason: 'Lý do gỡ liên kết',
    effectiveOnlyWhenPaid: 'Chỉ tính khi phiếu đã thực thi',
  },

  /** v2 — quy trình tự động (v2/v2.md §11.2, §11.5). */
  automation: {
    title: 'Quy trình tự động',
    rerun: 'Chạy lại',
    rerunHint: 'Chỉ chạy các bước chưa xong, không tạo trùng',
    ok: (code: string) => `${code} ✔`,
    failed: 'Lỗi — cần chạy lại',
    alertTitle: 'Quy trình tự động lỗi',
    empty: 'Chưa có quy trình tự động nào cho phiếu này',
    created: (what: string) => `Đã tạo ${what}`,
    cancelledWarning: (code: string) => `Đối tượng ${code} đã sinh từ phiếu đã huỷ — cần xử lý thủ công`,
  },

  auth: {
    login: 'Đăng nhập',
    email: 'Email công việc',
    password: 'Mật khẩu',
    logout: 'Đăng xuất',
    notYou: 'Không phải bạn? — Đăng xuất',
    forgot: 'Quên mật khẩu',
    otpCode: 'Mã OTP',
    resendIn: (s: number) => `Gửi lại sau ${s} giây`,
    verifyStepUp: 'Xác thực lại để tiếp tục',
    sessionExpired: 'Phiên làm việc đã kết thúc',
    keepDraft: 'Hệ thống giữ nội dung bạn đang nhập dở',
    restoreDraft: 'Khôi phục bản nháp',
    loginLock: 'Bạn đã nhập sai nhiều lần. Thử lại sau 15 phút.',
    checking: 'Đang kiểm tra…',
    enableMfa: 'Bật xác thực 2 lớp',
    scanQr: 'Quét mã bằng ứng dụng Authenticator',
    recoveryCodes: 'Mã dự phòng — lưu lại, mỗi mã dùng một lần',
  },

  empty: {
    noDocs: 'Chưa có hồ sơ nào',
    noResults: 'Không có kết quả với bộ lọc này',
    noPermission: 'Bạn không có quyền xem mục này',
    noNotifications: 'Chưa có thông báo nào',
    createFirst: 'Tạo đề nghị chi đầu tiên',
    clearFilters: 'Xóa bộ lọc để xem thêm',
  },

  error: {
    conflict: (name: string, at: string) => `Hồ sơ đã được ${name} duyệt lúc ${at}. Tải lại.`,
    overLimit: (limit: string) => `Vượt hạn mức duyệt của bạn (${limit})`,
    insufficientBalance: (account: string, available: string) =>
      `Số dư ${account} không đủ — khả dụng ${available}`,
    generic: 'Hệ thống đang gặp sự cố. Vui lòng thử lại.',
    notFound: 'Không tìm thấy mục bạn cần',
    networkLost: 'Mất kết nối tới máy chủ',
    serverSleeping: 'Máy chủ có thể đang ngủ — đang thử lại',
  },

  validation: {
    required: 'Bắt buộc nhập',
    invalidDate: 'Ngày không hợp lệ',
    invalidEmail: 'Email không hợp lệ',
    amountOverBalance: (left: string) => `Số tiền vượt số dư khả dụng (còn ${left})`,
    amountOverLimit: (account: string, left: string) => `Số tiền vượt hạn mức TK ${account} (còn ${left})`,
    groupAccountRequired: 'Giao dịch qua tài khoản Tập đoàn — bắt buộc chọn tài khoản phụ trách',
    missingFields: (fields: string) => `Thiếu trường bắt buộc: ${fields}`,
    endDateAfterStart: 'Ngày kết thúc phải sau ngày bắt đầu',
  },

  nav: {
    dashboard: 'Bảng điều hành',
    awaiting: 'Chờ tôi duyệt',
    approvedByMe: 'Tôi đã duyệt',
    needChanges: 'Cần bổ sung',
    income: 'Thu',
    spend: 'Chi',
    bank: 'Ngân hàng',
    loans: 'Khoản vay',
    rollover: 'Đảo hạn',
    debt: 'Công nợ',
    cashflow: 'Dòng tiền',
    reports: 'Báo cáo',
    admin: 'Quản trị',
    notifications: 'Thông báo',
    newsletter: 'Bản tin',
    today: 'Hôm nay',
    search: 'Tìm kiếm',
    settings: 'Cài đặt cá nhân',
    personnel: 'Nhân sự & Tài khoản',
    matrix: 'Quy trình duyệt',
    audit: 'Audit log',
  },

  confirm: {
    approveTitle: (amount: string, payee: string) => `Duyệt khoản ${amount} cho ${payee}?`,
    balanceImpact: (company: string, before: string, after: string) => `${company}: ${before} → ${after}`,
    discardDraft: 'Bỏ bản chỉnh sửa?',
    deactivateUser: 'Ngừng hoạt động tài khoản này? Người dùng sẽ mất quyền ngay lập tức.',
    bulkApprove: (n: number, total: string) => `Duyệt ${n} khoản · Tổng ${total}`,
    export: (n: string) => `Xuất ${n} dòng? File có đóng watermark người xuất.`,
  },

  fastTrackWarning: (n: number) => `Bạn đang duyệt trước — ${n} cấp dưới chưa kiểm tra`,
  retypeAmount: 'Khoản trên 5 tỷ hoặc ngoài ngân sách — gõ lại số tiền để xác nhận',
  internalTransferNote: 'Không tính vào chi phí/doanh thu',
} as const;

/** Nhãn vai trò + loại hồ sơ có dấu (mở rộng từ registry). */
export const KIND_SEGMENT: Record<string, string> = {
  spend: 'chi',
  income: 'thu',
  rollover: 'dao-han',
  internal: 'noi-bo',
};

export const SEGMENT_KIND: Record<string, string> = {
  chi: 'spend',
  thu: 'income',
  'dao-han': 'rollover',
  'noi-bo': 'internal',
};

/** Deep-link hồ sơ: `/ho-so/chi/:id` (screens DOC-01). */
export function docHref(kind: string, id: string): string {
  return `/ho-so/${KIND_SEGMENT[kind] ?? kind}/${id}`;
}

/** Route danh sách theo loại. */
export function listHref(kind: string): string {
  switch (kind) {
    case 'spend':
      return '/chi';
    case 'income':
      return '/thu';
    case 'rollover':
      return '/ngan-hang/dao-han';
    case 'internal':
      return '/ngan-hang/chuyen-noi-bo';
    default:
      return '/dashboard';
  }
}

/** "12 khoản" · "8 hồ sơ" — đếm luôn kèm đơn vị tiếng Việt (DS §11). */
export function countVi(n: number, unit: 'khoản' | 'hồ sơ' | 'ngày' | 'công ty' | 'file' = 'khoản'): string {
  return `${n.toLocaleString('vi-VN')} ${unit}`;
}

/** Nhãn bước trong timeline — không hard-code chuỗi ở screen. */
export function stepLabel(order: number, roleLabel: string): string {
  return `${order} · ${roleLabel}`;
}
