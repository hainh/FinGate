# FinGate Design System

**Phiên bản:** 1.0.0 · **Trạng thái:** Active
**Phạm vi:** Web app (desktop-first) + mobile approval của Hệ thống điều hành dòng tiền & phê duyệt tài chính FinGate.
**Áp dụng cho:** Figma/Penpot library `@fingate/design`, package UI `@fingate/ui`, và mọi màn hình sản phẩm.

> Tài liệu này là **specification**, không phải đề xuất. Giá trị token đã được chốt và đã đo contrast (xem §12.4).
> Muốn thay đổi giá trị nào → phải qua quy trình ở §13.3.

---

## 0. Cách đọc tài liệu này

| Chương | Nội dung | Ai dùng |
| --- | --- | --- |
| 1 | Nguyên tắc thiết kế + tiêu chí nghiệm thu | Design + PM |
| 2 | Token: màu, chữ, khoảng cách, radius, elevation, motion, z-index, breakpoint | Design + Dev |
| 3 | Hệ thống trạng thái & rủi ro (trung tâm của hệ thống) | Design + Dev + BA |
| 4 | Định dạng tiền tệ, số, ngày, giờ (vi-VN) | Dev + BA |
| 5 | Layout: app shell, grid, responsive | Design + Dev |
| 6–7 | Component inventory + spec chi tiết từng component | Design + Dev |
| 8 | Pattern màn hình (dashboard, approval detail, mobile) | Design + Dev |
| 9 | Data visualization | Design + Dev |
| 10–11 | Accessibility + ngôn ngữ UI tiếng Việt | Tất cả |
| 12 | Hiện thực: CSS variables, Tailwind, Ant Design Theme | Dev |
| 13 | Governance, roadmap, Do/Don't | Tất cả |

**Quy ước ký hiệu trong spec component:**
`A` = Anatomy (cấu tạo) · `V` = Variants · `S` = Sizes · `St` = States · `T` = Tokens dùng · `B` = Behavior · `AC` = Accessibility · `D/!D` = Do / Don't.

---

# 1. Design principles

Sản phẩm chỉ có một việc phải làm tốt: **giúp Giám đốc ra quyết định tài chính đúng, nhanh, và có bằng chứng.**

### 1.1 Decision first
Mọi màn hình phải trả lời được: *Tôi cần biết gì? Tôi làm gì tiếp?*
**Nghiệm thu:** trên mỗi màn hình, khu vực "hành động chính" phải nằm trong viewport đầu tiên ở 1440×900, không phải cuộn.

### 1.2 Risk is the hierarchy
Trạng thái rủi ro phải phân biệt được trong < 1 giây, bằng **icon + chữ + màu**, không bao giờ bằng màu đơn thuần.
**Nghiệm thu:** screenshot màn hình, đưa cho người không biết hệ thống, hỏi "cái gì nguy nhất?" → trả lời đúng.

### 1.3 Numbers are the content
Số tiền là nội dung chính, label là phụ. Chữ số luôn có trọng lượng thị giác lớn hơn nhãn đi kèm và luôn dùng `tabular-nums`.
**Nghiệm thu:** mọi cột số trong bảng thẳng hàng tuyệt đối theo dấu phân cách thập phân.

### 1.4 Progressive disclosure
Không nhồi tất cả vào một màn hình. Dòng chảy mặc định:
`Danh sách → Dòng tóm tắt → Chi tiết → Chứng từ → Lịch sử phê duyệt → Audit log`.

### 1.5 Nothing is silent
Mọi trạng thái đặc biệt phải có **nguyên nhân** và **trách nhiệm**: "Chờ Giám đốc duyệt · đã nằm ở đây 3 ngày · người lập Nguyễn A". Không có status cụt.

### 1.6 Desktop for control, mobile for the decision
Dashboard, bảng lọc, báo cáo tối ưu desktop ≥ 1280. Mobile chỉ làm 4 việc: **nhận notification → đọc hồ sơ → xem chứng từ → Duyệt/Từ chối/Yêu cầu bổ sung**.

### 1.7 Quiet Enterprise (phong cách)
Nền trung tính · border nhẹ · radius vừa · shadow rất ít · accent có kiểm soát · bảng dữ liệu sạch.
**Không dùng:** gradient, glassmorphism, card "bay", icon khổng lồ, > 1 màu accent, pie chart cho mọi thứ.
Lý do: các hiệu ứng đó đẹp ở demo nhưng sập ở 300 dòng giao dịch.

---

# 2. Design tokens

Ba tầng, **không được đi tắt**:

```text
PRIMITIVE  --fg-n-500, --fg-brand-600      (chỉ có trong file palette)
    ↓
SEMANTIC   --fg-text-muted, --fg-action-primary     ← UI chỉ dùng tầng này
    ↓
COMPONENT  --fg-button-primary-bg                  ← chỉ component dùng lại semantic
```

Quy tắc cứng: **Designer và Dev không dùng primitive token trong UI nếu đã có semantic token.**
Sai: `Button bg = brand-600` · Đúng: `Button bg = action.primary.background`.

Tên biến: `--fg-{layer}-{group}-{name}-{modifier}` (`fg` = FinGate).

---

## 2.1 Primitive palette

### Neutral (xám lạnh, dùng cho nền/text/border)

| Token | Hex | Ghi chú |
| --- | --- | --- |
| `--fg-n-0` | `#FFFFFF` | surface |
| `--fg-n-25` | `#F7F8FA` | page background |
| `--fg-n-50` | `#F2F4F7` | subtle background, table header |
| `--fg-n-100` | `#EAECF0` | border subtle |
| `--fg-n-150` | `#E1E5EB` | border default |
| `--fg-n-200` | `#D6DBE3` | border strong |
| `--fg-n-300` | `#BCC4D0` | divider on hover, skeleton |
| `--fg-n-400` | `#98A2B3` | **disabled text/icon only** |
| `--fg-n-500` | `#7C8798` | tertiary text (xem hạn chế §2.2) |
| `--fg-n-600` | `#5D6673` | muted text |
| `--fg-n-700` | `#3D4451` | secondary text |
| `--fg-n-800` | `#262B34` | sidebar background (dark rail) |
| `--fg-n-900` | `#171A1F` | primary text, dark surface |

### Brand (indigo navy — màu của hành động chính, không phải màu trang trí)

| Token | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hex | `#EEF1FE` | `#DCE2FD` | `#BAC6FB` | `#93A5F7` | `#6B80F0` | `#4759E0` | `#3445C4` | `#29379C` | `#1F2A78` | `#16205A` |

`brand-600` là màu mặc định của primary action. `brand-700` = hover/active. `brand-50/100` = nền đang chọn (selected row, soft badge).

### Status primitives

| Family | 50 | 100 | 500 | 600 | 700 |
| --- | --- | --- | --- | --- | --- |
| `success` (xanh lá) | `#E9F7EF` | `#CDEBD9` | `#1F9D55` | `#157F44` | `#0F6636` |
| `warning` (cam) | `#FFF1E8` | `#FFD9BF` | `#E0651A` | `#B84E0D` | `#8F3C08` |
| `attention` (vàng) | `#FFF8E1` | `#FFECB3` | `#B7860B` | `#946B04` | `#7A5804` |
| `danger` (đỏ) | `#FEF1F2` | `#FCD9DC` | `#CC2936` | `#A81E2B` | `#84161F` |
| `info` (xanh dương) | `#EDF4FC` | `#D5E6F7` | `#2477CC` | `#1B5FAA` | `#154A85` |

`warning` ≠ `attention`: **warning = cần xử lý sớm (cam)**, **attention = cần lưu ý (vàng)**. Cả hai tồn tại vì FinGate có 4 mức cảnh báo đáo hạn (§3.3).

### Fixed (không đảo ngược trong dark mode)

| Token | Hex | Dùng |
| --- | --- | --- |
| `--fg-fix-white` | `#FFFFFF` | text on accent |
| `--fg-fix-black` | `#000000` | overlay scrim (dùng với alpha) |
| `--fg-fix-overlay` | `rgba(16,19,24,.55)` | modal/drawer scrim |

---

## 2.2 Semantic tokens — Light

### Background

```text
--fg-bg-page          #F7F8FA   vùng nền app
--fg-bg-surface       #FFFFFF   card, panel, table, form
--fg-bg-subtle        #F2F4F7   table header, section label, placeholder block
--fg-bg-elevated      #FFFFFF   dropdown, modal, popover, toast
--fg-bg-inverse       #171A1F   tooltip, tour
--fg-bg-selected      #EEF1FE   dòng/side nav đang chọn (brand-50)
--fg-bg-hover         #F7F8FA   hover row, hover nav
--fg-bg-disabled      #F2F4F7   input/button disabled
--fg-bg-rail          #262B34   sidebar (nav rail tối, tương phản với nội dung)
--fg-bg-rail-hover    #3D4451   hover nav item trên rail tối (không dùng bg-hover)
```

### Text

| Token | Hex | Ratio trên page/surface | Dùng |
| --- | --- | --- | --- |
| `--fg-text-primary` | `#171A1F` | 16.4 / 17.4 | tiêu đề, số tiền, nội dung chính |
| `--fg-text-secondary` | `#3D4451` | 9.2 / 9.8 | body, label, tên người |
| `--fg-text-muted` | `#5D6673` | 5.5 / 5.8 | caption, meta, helper, timestamp |
| `--fg-text-tertiary` | `#7C8798` | 3.4 / 3.6 | **chỉ** cho icon/label phụ đã có text chính bên cạnh. Không dùng cho thông tin đơn lẻ (không đạt AA 4.5 — xem §10) |
| `--fg-text-disabled` | `#98A2B3` | — | disabled (được miễn AA) |
| `--fg-text-on-accent` | `#FFFFFF` | — | trên brand/danger/success solid |
| `--fg-text-link` | `#3445C4` | 7.5 | link, ID, tên mở drawer |
| `--fg-text-danger` | `#A81E2B` | — | số tiền/label rủi ro |
| `--fg-text-success` | `#157F44` | — | label tích cực |

### Border / focus

```text
--fg-border-subtle    #EAECF0   kẻ phân cách nội bộ card
--fg-border-default   #E1E5EB   card, input, table cell divider  ← mặc định
--fg-border-strong    #D6DBE3   input hover, bảng cần viền rõ
--fg-border-selected  #3445C4   card/option đang chọn
--fg-border-focus     #3445C4   focus ring 2px, offset 2px
--fg-border-on-dark   #2A313B   border trong dark mode
```

### Action

```text
--fg-action-primary            #3445C4
--fg-action-primary-hover      #29379C
--fg-action-primary-press      #1F2A78
--fg-action-primary-text       #FFFFFF
--fg-action-danger             #A81E2B
--fg-action-danger-hover       #84161F
--fg-action-danger-text        #FFFFFF
--fg-action-secondary-bg       #FFFFFF   (+ border-default, text-secondary)
--fg-action-soft-bg            #EEF1FE   (tertiary/ghost emphasis, text brand-700)
```

### Status semantic (mỗi status có đủ bộ 4 thuộc tính)

| Family | `.text` | `.bg` | `.border` | `.icon` (dot ≥3:1) |
| --- | --- | --- | --- | --- |
| success | `#157F44` | `#E9F7EF` | `#CDEBD9` | `#157F44` |
| warning | `#B84E0D` | `#FFF1E8` | `#FFD9BF` | `#B84E0D` |
| attention | `#946B04` | `#FFF8E1` | `#FFECB3` | `#946B04` |
| danger | `#A81E2B` | `#FEF1F2` | `#FCD9DC` | `#A81E2B` |
| info | `#1B5FAA` | `#EDF4FC` | `#D5E6F7` | `#1B5FAA` |
| neutral | `#5D6673` | `#F2F4F7` | `#E1E5EB` | `#5D6673` |

---

## 2.3 Semantic tokens — Dark theme

Dark mode là **first-class**: bật từ `data-fg-theme="dark"`, không phải bằng cách đổi nền trắng → đen. Nền không thuần đen (giảm mỏi mắt trong phòng điều hành ban đêm, tránh halo trên OLED).

| Semantic | Light | Dark |
| --- | --- | --- |
| `bg.page` | `#F7F8FA` | `#0E1116` |
| `bg.surface` | `#FFFFFF` | `#171A1F` |
| `bg.subtle` | `#F2F4F7` | `#12161C` |
| `bg.elevated` | `#FFFFFF` | `#1E232B` |
| `bg.rail` | `#262B34` | `#0B0E12` |
| `bg.railHover` | `#3D4451` | `#1E232B` |
| `text.primary` | `#171A1F` | `#E6E9EF` |
| `text.secondary` | `#3D4451` | `#C3CAD4` |
| `text.muted` | `#5D6673` | `#9AA4B2` |
| `text.link` | `#3445C4` | `#BAC6FB` |
| `border.default` | `#E1E5EB` | `#2A313B` |
| `action.primary` | `#3445C4` | `#6B80F0` (text on it: `#0B0E12`) |

Status trong dark dùng **text trên nền tối cùng họ** (không dùng nền pastel):

```text
success    text #5CCB8A  bg #14261C  border #1F4A32
warning    text #FFB877  bg #2A1C11  border #55361B
attention  text #FFD666  bg #26200E  border #4E411B
danger     text #FF9AA6  bg #291417  border #55262C
info       text #7FC0FF  bg #12202E  border #1D3550
neutral    text #9AA4B2  bg #12161C  border #2A313B
```

Contrast đã đo: mọi cặp text/bg trên ≥ 7.8:1.

---

## 2.4 Typography

**Font:** `Inter` (variable, tự host — không phụ thuộc Google Fonts CDN vì app chạy trong mạng nội bộ).
**Số tiền/ID/ngày trong bảng:** vẫn Inter, bật `font-feature-settings: "tnum" 1`.
**Mã / số hợp đồng / mã khoản vay:** `JetBrains Mono` (chỉ khi cần đối ký tự).

Stack: `Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.

| Token | Size / Line | Weight | Letter | Dùng |
| --- | --- | --- | --- | --- |
| `--fg-font-display` | 32 / 40 | 600 | -0.02em | KPI hero trên Dashboard |
| `--fg-font-h1` | 24 / 32 | 600 | -0.02em | Tên màn hình (page title) |
| `--fg-font-h2` | 20 / 28 | 600 | -0.01em | Section trong detail |
| `--fg-font-h3` | 17 / 24 | 600 | 0 | Card title, subsection |
| `--fg-font-h4` | 15 / 22 | 600 | 0 | Nhóm nhãn nhỏ |
| `--fg-font-body-l` | 15 / 24 | 400 | 0 | Nội dung ý kiến, ghi chú dài |
| `--fg-font-body` | 14 / 22 | 400 | 0 | **Mặc định** mọi text UI |
| `--fg-font-body-s` | 13 / 20 | 400 | 0 | Dense table cell, note |
| `--fg-font-caption` | 12 / 18 | 400 | 0 | Meta, timestamp, helper |
| `--fg-font-overline` | 11 / 16 | 600 | +0.06em | Section label in hoa (TÀI SẢN BẢO ĐẢM) — dùng hạn chế |
| `--fg-font-number-xl` | 32 / 38 | 600 | -0.01em | Số tiền KPI |
| `--fg-font-number-l` | 24 / 30 | 600 | -0.01em | Số tiền header hồ sơ |
| `--fg-font-number-m` | 15 / 20 | 500 | 0 | Số tiền trong table |
| `--fg-font-number-s` | 13 / 18 | 500 | 0 | Số phụ (delta, %) |

Quy tắc:
- Max **3 cỡ chữ trong một card**, **2 weight trong một màn hình** (400 + 600; 500 chỉ cho số).
- Không dùng weight 700. Không italic. Không uppercase cả câu (chỉ overline).
- Line length tối đa cho text ý kiến phê duyệt: **68ch**.

---

## 2.5 Spacing, sizing, radius, border

**Base 4px.** Không dùng giá trị nằm ngoài scale.

```text
--fg-space-0 0 · 1 4 · 2 8 · 3 12 · 4 16 · 5 20 · 6 24 · 8 32 · 10 40 · 12 48 · 16 64 · 20 80
```

| Dùng ở | Giá trị |
| --- | --- |
| Padding card | 16 (`space-4`) · card KPI 20 |
| Padding modal header/body | 20 / 24 |
| Gap trong cluster button | 8 |
| Gap giữ 2 section | 24 |
| Gap giữa 2 card cùng tầng | 16 |
| Cell table comfortable | 12 × 16 |
| Cell table compact | 8 × 12 |

Control height: `sm 32` · `md 40` (mặc định) · `lg 48`. Mobile touch target tối thiểu **44×44**.

**Radius**

```text
--fg-radius-xs 4   tag, kbd
--fg-radius-sm 6   input, button sm, icon button
--fg-radius-md 8   button md, card nhỏ, select  ← mặc định
--fg-radius-lg 12  card, panel, modal
--fg-radius-xl 16  drawer, overlay lớn
--fg-radius-full 999 status dot, avatar, badge pill
```

**Border width:** `--fg-border-w-1 1px` (mọi thứ) · `--fg-border-w-2 2px` (chỉ focus ring / active tab / risk stripe).

---

## 2.6 Elevation

Rất tiết chế. **Card thông thường không có shadow — chỉ border.**

```text
--fg-shadow-0  none                          card, panel, table   (border-default)
--fg-shadow-1 0 1px 2px rgba(23,26,31,.06)   sticky header, hover card
--fg-shadow-2 0 4px 12px rgba(23,26,31,.10)  dropdown, popover, toast
--fg-shadow-3 0 12px 32px rgba(23,26,31,.16) modal, drawer
--fg-shadow-4 0 16px 48px rgba(23,26,31,.20) floating approval bar (mobile)
```

Dark: thay `rgba(23,26,31,α)` bằng `rgba(0,0,0,α×1.6)` và tăng border sáng lên 1 nấc.

---

## 2.7 Motion

| Token | Value | Dùng |
| --- | --- | --- |
| `--fg-motion-instant` | 80ms | hover, press, active |
| `--fg-motion-fast` | 140ms | dropdown, tooltip, badge đổi trạng thái |
| `--fg-motion-base` | 200ms | modal, drawer, collapse |
| `--fg-motion-slow` | 320ms | drawer mobile, chuyển tab nội dung |
| `--fg-ease-out` | `cubic-bezier(.2,.8,.2,1)` | mặc định |
| `--fg-ease-in` | `cubic-bezier(.4,0,1,1)` | khi đóng |

Không animate: số tiền, thứ tự dòng bảng, trạng thái approval (chỉ đổi màu + icon). Không parallax, không bounce.
`@media (prefers-reduced-motion: reduce)` → mọi duration = 0, chỉ còn opacity.

---

## 2.8 Z-index

```text
--fg-z-table-sticky   10   cột cố định + header table
--fg-z-header         100  app header sticky
--fg-z-sidebar        200  rail + mobile nav
--fg-z-dropdown       900  select, menu, datepicker
--fg-z-drawer        1000
--fg-z-modal         1100
--fg-z-toast         1200
--fg-z-approval-bar  1300  action bar treo dưới mobile
```

---

## 2.9 Breakpoint & density

```text
--fg-bp-xs    0–767     mobile (approval-first)
--fg-bp-sm    768–1023  tablet: dashboard 2 cột, sidebar thành overlay
--fg-bp-md    1024–1279 laptop: rail 72px collapsed mặc định
--fg-bp-lg    1280–1439 desktop đầy đủ, rail 240
--fg-bp-xl    1440–1919 content max-width 1440, KPI 6 cột
--fg-bp-2xl   ≥1920     phòng điều hành: cho phép dark mode + font +1 nấc
```

`--fg-density`: `comfortable` (mặc định, row 44px) | `compact` (row 34px, font 13). Density lưu theo người dùng, ưu tiên `compact` cho Kế toán/Chuyên viên (nhập liệu nhiều), `comfortable` cho Giám đốc.

---

# 3. Hệ thống trạng thái & rủi ro

Đây là phần **quan trọng nhất và phải được code hóa**, vì toàn bộ sản phẩm xoay quanh nó. Có **3 registry riêng, không được trộn lẫn**:

1. **Workflow status** — hồ sơ đang ở đâu trong quy trình.
2. **Risk severity** — mức khẩn cấp/rủi ro (đáo hạn, dòng tiền âm, vượt ngân sách).
3. **Money direction/health** — tình trạng tiền (đã thu/chưa, vượt/dưới kế hoạch).

## 3.1 Workflow status registry (bắt buộc dùng exact string)

| Key | Nhãn vi | Icon | Status token | Dùng |
| --- | --- | --- | --- | --- |
| `draft` | Nháp | `○` | neutral | chưa gửi |
| `pending.kt` | Chờ kế toán kiểm tra | `◍` | info | đang ở bàn KT |
| `pending.ktt` | Chờ Kế toán trưởng | `◍` | info | |
| `pending.pgd` | Chờ Phó Giám đốc | `◍` | warning | đang chờ cấp phê duyệt |
| `pending.gd` | Chờ Giám đốc | `◍` | warning | |
| `approved` | Đã duyệt | `✓` | success | chốt duyệt, chưa trả tiền |
| `processing` | Đang thanh toán | `↻` | info | |
| `paid` | Đã thanh toán | `✓` | success | có chứng từ ngân hàng |
| `rejected` | Từ chối | `✕` | danger | kèm lý do bắt buộc |
| `changes_requested` | Yêu cầu bổ sung | `✎` | attention | kèm yêu cầu |
| `cancelled` | Hủy | `⊘` | neutral | |
| `overdue` | Quá hạn | `!` | danger | phải thu/chờ duyệt quá SLA |

Cấu trúc dữ liệu:

```ts
type StatusKey = 'draft'|'pending.kt'|'pending.ktt'|'pending.pgd'|'pending.gd'|
                 'approved'|'processing'|'paid'|'rejected'|'changes_requested'|'cancelled'|'overdue';
interface StatusDef { key: StatusKey; labelVi: string; glyph: string; tone: Tone; ownerRole?: Role; terminal: boolean }
```

**Quy tắc:**
- Chip trạng thái luôn = `icon + nhãn`, nền pastel + chữ đậm (màu semantic §2.2), radius `sm`, font `body-s` 500.
- `pending.*` phải hiển thị thêm **đang ở bàn ai**: `● Chờ Giám đốc duyệt`.
- `overdue` được **thêm** vào status gốc, không thay thế → hiển thị 2 chip, chip quá hạn có priority cao hơn.
- Fast-track (blueprint §IV): khi có cấp cao hơn đã duyệt trước, status vẫn tính theo **cấp thấp nhất chưa duyệt**, hiển thị thêm chip info `Đã duyệt trước bởi {cấp}`.
- Không dịch key sang tiếng Anh trong UI; không viết "Đã Duyệt", "pending".

## 3.2 Risk severity

| Level | Tên | Token | Icon | Khi nào |
| --- | --- | --- | --- | --- |
| 0 | Bình thường | neutral | — | không có gì để nói |
| 1 | Lưu ý | attention | `▲` nhỏ | cần biết, chưa hành động |
| 2 | Cảnh báo | warning | `⚠` | hành động trong tuần |
| 3 | Nghiêm trọng | danger | `⛔`/`●` | hành động hôm nay |

Bao giờ cũng đi kèm **số + thời hạn**: `⚠ Đáo hạn trong 3 ngày · 35,00 tỷ`.

## 3.3 Maturity ladder (module đảo hạn) — ánh xạ cố định

| Ngưỡng | Level | Token | Nhãn |
| --- | --- | --- | --- |
| Đáo hạn hôm nay | 3 | danger | `Hôm nay` |
| ≤ 3 ngày | 3 | danger | `Còn 2 ngày` |
| 4–7 ngày | 2 | warning | `Còn 6 ngày` |
| 8–30 ngày | 1 | attention | `Còn 18 ngày` |
| > 30 ngày | 0 | neutral | chỉ hiện số ngày |

Luôn hiện **số ngày cụ thể**, không chỉ màu.

## 3.4 Colour must not carry meaning alone

Mọi mức độ rủi ro phải qua được test: **in đơn sắc (grayscale) vẫn phân biệt được.**
Sai: `🔴` · Đúng: `🔴 Đáo hạn trong 3 ngày`.

## 3.5 Account status registry (nhân sự — blueprint §XXIX)

Registry riêng cho tài khoản nhân sự, **không trộn** với workflow status (§3.1):

| Key | Nhãn vi | Tone | Dùng |
| --- | --- | --- | --- |
| `invited` | Chờ kích hoạt | attention | đã gửi email mời, chưa tạo tài khoản |
| `active` | Đang hoạt động | success | đăng nhập được, đủ quyền theo vai trò |
| `deactivated` | Ngừng hoạt động | neutral | đã khóa; tên trong hồ sơ cũ kèm nhãn này |

Chip dùng `FgStatusChip` chuẩn (icon + nhãn). Không dùng danger cho `deactivated` — đây là trạng thái hành chính, không phải rủi ro.

---

# 4. Định dạng số tiền, số, ngày (vi-VN)

Mặc định locale `vi-VN`. **Phân cách thập phân là dấu phẩy** — không được viết `125.6 tỷ`.

## 4.1 Tiền tệ

| Trường hợp | Format | Ví dụ |
| --- | --- | --- |
| Giá trị pháp lý (chi tiết, phê duyệt, chứng từ) | `#,##0` + ` ₫` (dấu chấm phân cách nghìn) | `2.500.000.000 ₫` |
| Bảng dữ liệu (compact) | `#,##0` + suffix, 0–2 px | `2,50 tỷ` |
| KPI | `#,##0.##` + suffix | `125,6 tỷ` |
| forecast/table nhỏ | `1,25 tỷ` | |
| Vãng lai ngoại tệ | `#,##0.00 USD` + ghi `≈ x,xx tỷ` | `25.000,00 USD ≈ 0,66 tỷ` |
| Số âm | prefix `−` (U+2212) + tone danger **chỉ khi là rủi ro**; dòng tiền thuần âm luôn đỏ | `−4,00 tỷ` |
| Zero | `0 ₫`, không viết `—` | `—` nghĩa là *chưa có dữ liệu* |
| Chưa có dữ liệu | `—` (em dash) | |

Suffix scale: `< 1.000.000` → ₫ đầy đủ · `1 triệu–999,99 triệu` → `tr` (`850 tr`) · `≥ 1 tỷ` → `tỷ` (`2,50 tỷ`) · `≥ 1.000 tỷ` → `nghìn tỷ`.
Precision mặc định khi compact: **2 chữ số thập phân** (`1,25 tỷ`), KPI tổng cho phép 1 chữ số nếu ≥ 100 tỷ (`125,6 tỷ`).

## 4.2 Implementation

```ts
// @fingate/ui/format
export const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
export function money(vnd: number, mode: 'full'|'compact'|'kpi' = 'full'): string;
export function pct(v: number, d = 1): string;      // "+8,4%"
export function days(n: number): string;            // "hôm nay" | "2 ngày tới" | "còn 6 ngày"
```
**Cấm** component tự gọi `toLocaleString()` hoặc hard-code `.`/`,`. Mọi output số đi qua `@fingate/ui/format` để còn đổi locale (Excel export dùng cùng hàm).

## 4.3 Ngày, giờ, số khác

| Loại | Format | Ví dụ |
| --- | --- | --- |
| Ngày đầy đủ | `DD/MM/YYYY` | `15/09/2026` |
| Ngày trong bảng | `DD/MM` nếu cùng năm, ngược lại `DD/MM/YYYY` | `15/09` |
| Ngày + giờ audit | `DD/MM/YYYY HH:mm` | `08/09/2026 09:15` |
| Giờ | `HH:mm`, 24h, không AM/PM | `08:32` |
| Gần đây | `vừa xong / N phút trước / N giờ trước / hôm qua`, sau 48h → absolute | |
| Thứ trong tuần | `T2 … CN`, viết tắt trong forecast: `T2 08/09` | |
| Số lượng | `#,##0` (`1.284 hồ sơ`) | |
| Phần trăm | 1 thập phân, luôn có dấu `+`/`−` khi là delta | `+8,4%` |
| Lãi suất | 2 thập phân + `%/năm`, kỳ trả riêng | `9,50 %/năm · trả lãi cuối kỳ` |
| SLA chờ duyệt | số ngày nguyên, quá ngưỡng → danger | `3 ngày` |

---

# 5. Layout system

## 5.1 App shell (desktop)

```text
┌────────────────────────────────────────────────────────────┐
│ HEADER 64px  (logo · scope công ty · search · alert · user)│
├──────────────┬─────────────────────────────────────────────┤
│ RAIL         │  CONTENT                                    │
│ 240 (72 coll)│  padding 24 · max-width 1440 · gap 24       │
│ bg-inverse   │  ┌ page header (h1 + actions) ────────┐     │
│              │  ┌ filter bar (sticky) ───────────────┐     │
│              │  ┌ content grid ──────────────────────┐     │
└──────────────┴──────┴─────────────────────────────────────┘
```

- Header sticky `z-header`, nền `bg-surface`, border-bottom `border-default`.
- Rail nền `bg-rail` (#262B34) — nav tối giúp nội dung sáng nổi bật và cho biết "đây là khu điều khiển".
- Rail theo cấu trúc menu của blueprint: `DASHBOARD · Chờ tôi duyệt · THU · CHI · NGÂN HÀNG · CÔNG NỢ · DÒNG TIỀN · BÁO CÁO · QUẢN TRỊ`; nhóm cấp 2 collapse được, badge số lượng ở `Chờ tôi duyệt`.
- Nội dung cuộn độc lập với rail; không scroll toàn trang (bảo toàn action bar & filter).

## 5.2 Content grid

12 cột · gutter 16 · margin 24.

| Pattern | Cột | Ghi |
| --- | --- | --- |
| KPI card | `xl:3+3+3+3` · `lg:4+4+4` · `md:6+6` | tối đa 4 KPI/tầng |
| Chart chính (cash flow) | 12 hoặc 8 (kèm 4 exception list) | |
| Bảng dữ liệu | 12 | |
| Detail drawer | 6/12 trên `xl`, 100% dưới `xl` | |
| Approval panel | 4/12 cạnh nội dung hồ sơ trên `xl` | |

Không quá **2 tầng thông tin** trong một viewport; mỗi tầng có 1 section label.

## 5.3 Page header mẫu

```text
[← Danh sách]  Khoản chi 2,50 tỷ — Thanh toán NCC ABC        [In] [Xuất Excel]
Công ty A · Nguyễn Văn A · 15/09/2026        [● Chờ Giám đốc duyệt]
```
`h1` = tên nghiệp vụ (không phải mã). Mã hồ sơ hiển thị dạng `text-link` để copy/sao chép liên kết.

## 5.4 Responsive behaviour

| Màn hình | Thay đổi |
| --- | --- |
| ≥1440 | dashboard đầy đủ 5 tầng (§8.1), detail = drawer 6 cột |
| 1280–1439 | KPI 4 cột, drawer overlay |
| 1024–1279 | rail collapsed 72, bỏ cột `Người lập` & `Bộ phận`, KPI 4 → 2×2 |
| 768–1023 | rail overlay, dashboard 2 cột, table → card list có 4 field |
| <768 | chỉ còn: Tiền hiện có → Cần duyệt → Cảnh báo → Đáo hạn → Dòng tiền; bottom tab 4 mục |

Mobile **không** là desktop thu nhỏ: không có filter bar đa cột, không có bảng > 3 cột.

---

# 6. Component inventory

Prefix `Fg`. Package `@fingate/ui`. Không dùng raw AntD trong screen — chỉ trong `Fg*` wrapper.

**Foundation (P1)**
`FgButton` `FgIconButton` `FgText` `FgLink` `FgDivider` `FgTooltip` `FgSpinner` `FgSkeleton` `FgIcon` `FgDot` `FgMoney`

**Form (P1–P2)**
`FgField` `FgInput` `FgTextarea` `FgMoneyInput` `FgNumberInput` `FgSelect` `FgMultiSelect` `FgDatePicker` `FgDateRange` `FgCheckbox` `FgRadio` `FgSwitch` `FgUpload` `FgCompanyPicker` `FgUserPicker` `FgCategoryPicker` `FgGroupAccountPicker`

**Navigation (P2)**
`FgAppShell` `FgSidebar` `FgHeader` `FgBreadcrumb` `FgTabs` `FgPagination` `FgMenu` `FgScopeSwitcher` `FgSegmented`

**Data (P2–P3)**
`FgTable` `FgFilterBar` `FgKpiCard` `FgStatRow` `FgStatusChip` `FgToneChip` `FgMoneyCell` `FgTimeline` `FgApprovalTimeline` `FgApprovalActionBar` `FgOpinion` `FgDocList` `FgBankAccountCard` `FgLoanCard` `FgMaturityTable` `FgCashFlowTable` `FgDebtBar` `FgChart.line/bar/stacked/area/donut` `FgDelta`

**Feedback (P2)**
`FgAlert` `FgExceptionList` `FgToast` `FgEmptyState` `FgErrorState` `FgBadgeCount` `FgProgress` `FgTooltipMetric`

**Overlay (P2)**
`FgModal` `FgConfirmDialog` `FgDrawer` `FgPopover` `FgContextMenu` `FgCommandPalette` `FgInviteUserDialog`

---

# 7. Component specifications

Mỗi spec: **A**natomy · **V**ariants · **S**izes · **St**ates · **T**okens · **B**ehavior · **AC** a11y · **D/!D**.

## 7.1 FgButton

**A:** `[icon?] [label] [suffix icon?]` — padding `0 16`, radius `md`, font `body` 500, label 1 dòng.
**V:**

| Variant | bg | text | border | Khi nào |
| --- | ---| ---| ---| ---|
| `primary` | action.primary | on-accent | — | Duyệt · Tạo đề nghị · Lưu · Gửi |
| `secondary` | surface | secondary | border-default | Lưu nháp · Xuất Excel · Chọn |
| `tertiary` | transparent | text.link | — | Xem chi tiết · Mở hồ sơ |
| `danger` | action.danger | on-accent | — | Từ chối · Xóa · Hủy |
| `danger-outline` | transparent | text.danger | danger 40% | Yêu cầu bổ sung (destructive nhẹ) |
| `ghost` | transparent | muted | — | toolbar, icon-only |

**S:** `sm` 32 (dense table toolbar) · `md` 40 (mặc định) · `lg` 48 (mobile action bar).
**St:** default · hover · active · focus-visible (ring 2px brand + offset 2) · disabled (bg subtle, text `n-400`, no shadow, vẫn giữ border) · loading (spinner trái, `aria-busy`, width giữ nguyên) · success-flash (`FgApprovalActionBar` chỉ).
**B:** click phải có phản hồi < 100ms; action bất đồng bộ → `loading`, disable cả nhóm (`fieldset`); **không có button thứ hai cùng variant primary trong một vùng**; action không thể hoàn tác → `FgConfirmDialog`.
**AC:** phần tử `<button type="button">`, label ngắn nhất mô tả hành động; icon-only buộc `aria-label` + tooltip; touch ≥ 44 trên mobile.
**D/!D:** D — `Duyệt`, `Từ chối`, `Yêu cầu bổ sung`. !D — button gradient, button 2 dòng, `OK`/`Đồng ý` cho action tài chính (luôn dùng động từ cụ thể).

## 7.2 FgIconButton
**A:** square `24/32/40` (sm/md/lg), radius `sm`, icon 16/18/20, tone `muted` → `primary` khi hover.
**St:** default, hover (bg subtle), active, focus, disabled, `pressed` (toggle, bg selected + border-selected).
**AC:** bắt buộc `aria-label` + `aria-pressed` với toggle; tooltip xuất hiện sau 400ms; hit area ≥ 40 (desktop) / 44 (mobile) kể cả khi icon 16.
**Dùng:** ⋯ row actions, close, filter, refresh, expand. **!D:** không dùng icon button cho approve/reject.

## 7.3 FgMoney / FgAmount (component trung tâm)

**A:** `[sign][int][sep][dec][suffix]` + optional `[delta]` + optional `[currency]`.

```text
2,50 tỷ          ← compact (table, card)
2.500.000.000 ₫  ← full (detail, phê duyệt, in)
↑ 8,4%           ← delta, token success/danger theo Ý NGHĨA, không theo dấu
```

**Props:**
```tsx
<FgMoney value={2_500_000_000} mode="compact" tone="auto" showDelta={delta} precision={2}
         currency="VND" signed />
```
`tone`: `neutral | risk | positive | negative | auto`.
- `auto` = mặc định, **không tô màu**; chỉ dùng tone khi giá trị mang trạng thái rủi ro/health (§3.4).
- Cấm mặc định "tiền ra = đỏ". Khoản chi hợp lệ đã duyệt vẫn là neutral.

**B:** luôn `text-align: right` + `tabular-nums`; trong detail phải có **cả hai**: compact ở header, full ở thông tin chi tiết; click số tiền (role `button`) → xem audit ảnh hưởng số dư.
**AC:** `aria-label` đọc đầy đủ: `"hai phẩy năm tỷ đồng"` → dùng `Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'})` cho screen reader.
**D/!D:** D — `1.250.000.000 ₫`. !D — `1,25 tỷ (1.250.000.000đ)` lặp trong cùng một card; viết `1,25 Tỷ`, `VND 1,25 ty`, `1.25B`.

## 7.4 FgStatusChip
**A:** `[dot/icon 12][label]` · padding `2 8` · radius `sm` · font `body-s` 500 · bg/border/text theo tone §2.2.
**V:** `soft` (mặc định) · `outline` (nền transparent, khi ở trong bảng đông chip) · `strong` (solid, chỉ cho quá hạn trên exception list) · `withOwner` (`● Chờ Giám đốc duyệt · 3 ngày`).
**St:** default · focusable (khi click mở timeline) · `pulse` 1 lần khi vừa cập nhật từ server (không loop).
**B:** chip là **button** nếu mở được chi tiết; order khi có nhiều chip: `overdue` → workflow → thông tin phụ.
**AC:** `role="status"`, `aria-label="Trạng thái: Chờ Giám đốc duyệt"`.
**D/!D:** !D — chip tự tạo màu riêng, chip không icon, text ALL CAPS.

## 7.5 FgField (label + control + helper + error)

**A:**
```text
Label (body 500, secondary)  [?]tooltip
─────────────────────────────  control
Helper / Error / Counter (caption, muted | danger)
```
**V:** `default` `required` `optional` `inline` (label trái, ≥ 280px control) · `readonly`.
**St:** default · hover (border-strong) · focus (border-focus + ring) · filled · disabled · error · warning (attention) · readonly (bg subtle, text primary, không border, **vẫn chọn/copy được text**).
**B:** label luôn ở trên control; `required` = dấu `*` màu danger + `aria-required`; error chỉ hiện sau blur/submit, không đổi layout (chỗ trống reserved); helper và error không hiển thị đồng thời → error thắng; mỗi lỗi phải nêu **cách sửa**: `Số tiền vượt hạn mức TK VCB 0711… (còn 1,80 tỷ)`.
**AC:** `aria-describedby` tới helper/error; focus tự nhảy tới field lỗi đầu tiên khi submit fail.

## 7.6 FgMoneyInput
**A:** `[prefix ₫/USD] [input] [suffix "≈ 2,50 tỷ"]` + `text-align: right`, `tabular-nums`, group separator khi gõ.
**Behavior:**
- Giá trị lưu **nguyên (integer VND)**, không dùng float.
- Format khi gõ: `2500000000` → hiển thị `2.500.000.000`.
- Paste từ Excel: chấp nhận `2,5 tỷ` / `2.500.000.000` / `2500000000`.
- Gõ số → helper realtime: `≈ 2,50 tỷ`.
- Vượt hạn mức/số dư khả dụng → `warning` hoặc `error` theo ngưỡng (§Approval matrix).
- `readOnly` khi hồ sơ đã qua cấp hiện tại.
**Keyboard:** ↑/↓ ±1.000.000, Shift+↑/↓ ±10.000.000, Ctrl+↑/↓ ±100.000.000.
**D/!D:** !D — cho nhập float "2.5" rồi suy ra đơn vị ở backend.

## 7.7 FgSelect / FgMultiSelect / FgCompanyPicker
- Menu: bg `elevated`, shadow-2, radius `lg`, max-height 320, item 40 (`body`), grouped + sticky group label `overline`.
- Search bắt buộc khi options > 10; placeholder `Chọn…`.
- `MultiSelect`: chip đã chọn trong trigger, `x` để bỏ, `+3 nữa` khi tràn, `Chọn tất cả (128)` ở đầu menu.
- `FgCompanyPicker` (= `FgScopeSwitcher` trigger): options = `Tất cả công ty` + từng công ty; **scope là thuộc tính phiên làm việc**, ghi nhớ theo người dùng, hiện ở header bằng `FgScopeChip`, đổi scope phải refetch mọi số liệu và giữ nguyên bộ lọc.
- `FgGroupAccountPicker` (blueprint §VIII/§XXX): chọn **tài khoản tập đoàn phụ trách** trong phiếu thu/chi; option = `[Ngân hàng · số TK masking · tên TK · số dư khả dụng]`; tài khoản bị khóa = disabled + tooltip lý do; field `required` khi phiếu dùng nguồn tiền tập đoàn (helper: "Giao dịch qua tài khoản Tập đoàn — bắt buộc chọn"); chỉ Chủ tịch HĐQT thấy mục cấu hình danh sách này trong Quản trị.
- Keyboard: type-ahead, `Esc` đóng, `Enter` chọn, focus trap trong menu, `aria-activedescendant`.
- !D: không dùng select cho ≤ 3 options → dùng `FgSegmented`.

## 7.8 FgDatePicker / FgDateRange
- Lịch 7 cột, `T2` đầu tuần (thứ bảy/chủ nhật muted), hôm nay có dot brand, ngày có sự kiện có dot tone tương ứng, ngày bị chặn `n-400` + tooltip lý do.
- Presets: `Hôm nay · 7 ngày · 30 ngày · Tháng này · Quý này · Năm nay · Tùy chọn`.
- Range: ô `Từ` → `Đến`, preview highlight khi hover; `Đến < Từ` → error inline.
- Input luôn format `DD/MM/YYYY`, cho phép gõ tay.

## 7.9 FgUpload / FgDocList
**A:** Dropzone `[icon + "Tải lên hoặc kéo thả" + helper "PDF, DOCX, XLSX, JPG, PNG · tối đa 20MB"]`.
Item row: `[type badge][tên file 1 dòng ellipsis][size][ngày upload][người tải][⋯ preview/tải/xóa]`.
**St:** idle · dragover (dashed border-selected, bg selected) · uploading (progress 2px dưới item) · success · error (danger text + retry) · `missing` (**thiếu chứng từ bắt buộc** → attention/danger + cảnh báo trong `FgApprovalActionBar`).
**Behavior:** preview PDF inline trong drawer, không rời trang; ảnh có lightbox; **file không thể xóa nếu đã có cấp duyệt tham chiếu** → chỉ thêm, không xóa (audit).
**AC:** `role="list"`, mỗi item có label đầy đủ; progress công bố `aria-live="polite"`.

## 7.10 FgTable (transaction table — component dùng nhiều nhất)

**A:**
```text
[header: column label + sort + resize]
[row: select? | primary cells | money cells | status | actions ⋯]
[footer: pagination]
```
**Column order chuẩn (CHI/THU):**
`○ · Mã/Nội dung · Công ty · Người lập · Loại khoản chi · Đối tượng · Ngày thanh toán · Số tiền · Trạng thái · ⋯`
> 8 cột → bật column chooser, mặc định ẩn `Bộ phận`, `Loại`.

**B:**
- Text `left` · **Số tiền `right`** · `center` chỉ cho status trong bảng hẹp; **không center toàn bảng**.
- Row height: 44 comfortable / 34 compact; hover `bg-hover`; selected `bg-selected` + border-left 2 brand; click row → `FgDrawer` (không điều hướng trang, giữ ngữ cảnh lọc).
- Sort: mặc định `Ngày thanh toán desc`; ưu tiên `Chờ tôi duyệt` lên đầu khi `scope=mine`.
- Sticky header + sticky cột đầu; `⋯` row menu (Xem · Sao chép liên kết · In · Nhân bản · Lịch sử).
- Bulk bar xuất hiện khi chọn ≥ 1: `Đã chọn 12 · Tổng 18,40 tỷ · [Duyệt hàng loạt] [Xuất] [Bỏ chọn]` — **duyệt hàng loạt bắt buộc hiện tổng tiền + vẫn mở review từng hồ sơ**.
- Infinite scroll không dùng cho bảng tài chính → pagination `20/50/100`, giữ trang khi reload.
- Column chooser và density ghi nhớ theo người dùng.
**St:** loading (skeleton 8 dòng, không spinner che nội dung) · empty (`FgEmptyState` + CTA tạo đề nghị, phân biệt "không có dữ liệu" và "không có kết quả lọc") · error (retry) · partial (dữ liệu công ty X chưa đồng bộ → `FgAlert` trên bảng).
**AC:** `<table>` thật, `scope="col"`, sort button `aria-sort`, caption ẩn; keyboard `↑↓` di chuyển row, `Enter` mở drawer, `Space` chọn.
**!D:** nested sub-table mặc định (dùng expand row chủ đích) · line-height > 2 trong cell · border dọc · zebra + border cùng lúc.

## 7.11 FgFilterBar
**A:** `[search] [scope chip] [status multi] [loại] [công ty] [ngày range] [số tiền range] [⋯ thêm] [Xóa lọc] [Lưu view] [Xuất]`
**B:** wrap 1–2 dòng; active filter = chip `label: value ×`; "Xóa lọc" chỉ hiện khi có filter; `Lưu view` cho named view lưu theo người dùng; tìm kiếm debounce 300ms, đếm `128 hồ sơ`; URL là source of truth (`?status=pending.gd&q=ABC`) → deep-link được từ notification.

## 7.12 FgKpiCard

```text
┌──────────────────────────────┐
│ Tổng tiền hiện có          ⋯│  caption 12 muted
│ 125,6 tỷ                     │  number-xl text-primary
│ ↑ 8,4% so với tháng trước    │  delta + context caption
│ ───sparkline (tùy chọn)─────  │
└──────────────────────────────┘
```
**A:** label → value → delta → breakdown (tối đa 3 dòng `FgStatRow`). **Không:** icon khổng lồ, gradient, donut 5 màu, > 7 dòng.
**V:** `default` · `risk` (border-left 2 danger, chỉ khi có vấn đề) · `clickable` (→ màn hình chi tiết) · `mini` (dùng trong drawer).
**B:** luôn nói rõ **phạm vi + thời điểm**: `Tất cả công ty · 08/09/2026`; breakdown chuẩn của KPI "Tiền hiện có": `Tiền mặt · Tiền ngân hàng · Bị hạn chế`; sub-line là số **có nghĩa quyết định**, không phải số decorative.
**St:** loading (skeleton 3 dòng) · stale (badge `Cập nhật 07:30` màu attention nếu > 24h).

## 7.13 FgApprovalTimeline (component đặc trưng sản phẩm)

**A:**
```text
✓ 1 · Kế toán kiểm tra       Nguyễn A   Đã kiểm tra   08/09 08:32
│  Ý kiến: "Đã đối chiếu HĐ 24/2026."
✓ 2 · Kế toán trưởng         Nguyễn B   Đã duyệt      08/09 09:15
│
● 3 · Phó Giám đốc           BẠN        Chờ bạn duyệt · 3 ngày
│  ○ 4 · Giám đốc                       Có thể duyệt ngay
│  ○ 5 · Chủ tịch HĐQT                  Có thể duyệt ngay
```
Node: `[rail connector] [state icon + ring] [cấp + người] [status + thời gian chờ] [ý kiến]`.
**State node:** `done` (success ✓) · `current` (cấp thấp nhất chưa duyệt — người vừa được thông báo; brand/danger filled ring + nhãn "BẠN" in hoa) · `ready` (cấp cao hơn, neutral hollow ○ + nhãn "Có thể duyệt ngay" — theo cơ chế fast-track, blueprint §IV) · `done-early` (success ✓ + nhãn "Đã duyệt trước") · `rejected` (danger ✕) · `skipped` (dashed, tooltip lý do: cấp dưới chưa xử lý trước khi cấp cao nhất theo Approval Matrix duyệt, hoặc cấp bị bỏ qua theo matrix).
**B:**
- Đọc từ trên xuống theo thứ tự quy trình thật; **cấp hiện tại luôn nổi bật**, đặt trong `bg-selected` row.
- Fast-track: **mọi cấp duyệt chưa xử lý đều có action bar**, không chỉ cấp hiện tại; mỗi lần một cấp duyệt xong → notification đẩy lên cấp cao hơn kế tiếp, timeline cập nhật realtime (chip `pulse` 1 lần).
- Hiển thị **thời gian đã chờ ở cấp hiện tại** (`3 ngày`) — SLA là dữ liệu, không phải metadata.
- Mỗi node cho xem ý kiến; ý kiến khi Từ chối là **bắt buộc** và hiển thị ngay dưới node.
- Có `Đang ở bàn: ai` ở mọi trạng thái `pending.*` (= cấp thấp nhất chưa duyệt); nếu có cấp cao hơn đã duyệt trước → hiện thêm `Đã duyệt trước bởi {cấp}`.
- Nếu Approval Matrix động: hiện `Quy trình áp dụng: khoản > 5 tỷ` để người duyệt hiểu vì sao có cấp Chủ tịch HĐQT.
**St:** loading · compressed (≤ 5 node hiện đủ; > 6 node collapse các node `done` giữa, giữ cấp cuối cùng + current).
**AC:** `aria-label="Quy trình 5 cấp, đang ở cấp 3: Phó Giám đốc, chờ 3 ngày"`; mỗi node là list item; thời gian chờ có text, không chỉ màu.

## 7.14 FgApprovalActionBar

Desktop: cuối drawer/`detail` panel, **sticky bottom của panel**, luôn thấy mà không cuộn.
```text
                                    [Từ chối]  [Yêu cầu bổ sung]  [Duyệt khoản 2,50 tỷ]
```
**B & quy tắc an toàn (bắt buộc):**
1. Nút duyệt phải **chứa số tiền** → chống duyệt nhầm khi có 12 hồ sơ giống nhau.
2. Primary **bên phải nhất**, width cố định theo nội dung, order cố định: `danger → danger-outline → primary`.
3. Trước khi commit, mở `FgApprovalConfirm` hiện **7 câu hỏi kiểm soát** (blueprint §XXVII): chi cho ai · bao nhiêu · để làm gì · căn cứ hợp đồng/chứng từ · tiền lấy từ tài khoản nào · sau khi chi còn bao nhiêu · có trong ngân sách/kế hoạch? (khoản ngoài kế hoạch → warning stripe + checkbox xác nhận). Duyệt trước khi cấp dưới chưa xử lý (fast-track) → thêm stripe attention: `Bạn đang duyệt trước — {N} cấp dưới chưa kiểm tra`.
4. Khoản `> 5 tỷ` hoặc ngoài ngân sách → yêu cầu **gõ lại số tiền** + `reason` ≥ 20 ký tự.
5. Từ chối / Yêu cầu bổ sung → bắt buộc chọn/sửa `reason` trong `FgReasonPicker` + ý kiến.
6. Thành công: toast + advance timeline + auto-mở hồ sơ kế tiếp trong hàng chờ (tùy chọn theo setting).
7. 409 (hồ sơ đã bị người khác duyệt) → alert: `Hồ sơ đã được Nguyễn B duyệt lúc 09:15. Tải lại.` — không ghi đè im lặng.
**Mobile:** `FgActionBar` cố định đáy, 44px+; `Duyệt` primary full-width; Từ chối/Yêu cầu trong `⋯`; duyệt phải có confirm bottom-sheet có số tiền + sinh hiệu (biometric) nếu bật 2FA.

## 7.15 FgOpinion / FgCommentThread
**A:** `[avatar][tên + vai trò][timestamp][nội dung]` + `[chỉ thấy bởi vai trò?]`.
Textarea: `body-l`, placeholder `Ý kiến của bạn (bắt buộc khi từ chối)…`, counter, `Ctrl+Enter` gửi.
Bao gồm: loại ý kiến (`Kiến nghị`, `Cảnh báo rủi ro`, `Trao đổi`), pin-to-top cho ý kiến rủi ro, không cho sửa ý kiến đã vào audit — chỉ gửi ý kiến mới.

## 7.16 FgAlert (in-page)
**V:** `danger | warning | attention | info | success` — bg pastel, border cùng họ, icon + title + body + actions.
**B:** title bắt buộc có **số lượng/hành động**: `8 khoản phải thu quá hạn · 3,20 tỷ`; actions inline (`Xem 8 khoản`) ; dismiss → `×`, nhưng alert rủi ro mức 3 không dismiss được mà phải xử lý.

## 7.17 FgExceptionList ("Cần xử lý")
Pattern đặc trưng: danh sách **câu hành động**, không phải bảng.
```text
⛔ 2 khoản vay đáo hạn trong 3 ngày        35,00 tỷ   [Xem]
⚠ 3 khoản chi > 1 tỷ chờ bạn duyệt          8,50 tỷ   [Duyệt]
⚠ Công ty B dự kiến thiếu 5,00 tỷ ngày 12/09 [Forecast]
● 8 khoản phải thu quá hạn                  3,20 tỷ   [Đôn đốc]
▲ Hồ sơ 24-0912 thiếu chứng từ               —        [Bổ sung]
```
Row: `[icon severity][câu mô tả có số][số tiền right][CTA]`. Sắp xếp theo severity rồi theo ngày. Tối đa 6 item ở dashboard → `Xem tất cả (18)`.

## 7.18 FgToast / notification
Vị trí `top-right` (desktop), `bottom` (mobile). 5s mặc định, 8s khi có `undo`. Vary: `success | danger | info` + action. Không dùng toast cho lỗi form (dùng inline) và không dùng toast cho thứ người dùng phải thấy khi quay lại (dùng `FgAlert` + notification center).

## 7.19 FgModal / FgConfirmDialog / FgDrawer
| | Modal | Drawer |
| --- | --- | --- |
| Dùng | confirm, form nhỏ ≤ 8 field | xem hồ sơ, form dài, so sánh |
| Rộng | 400 / 560 / 720 | 480 / 640 / 50% viewport |
| Sticky | header + footer | header + action bar |
| Close | `Esc`, `×`, scrim (chỉ khi form rỗng) | như Modal + `←` |

- Confirm dialog: title là câu hỏi hành động (`Duyệt khoản 2,50 tỷ cho NCC ABC?`), body nêu hậu quả (`Công ty A: 12,40 tỷ → 9,90 tỷ`), button là động từ cụ thể.
- Dirty form (chưa lưu): confirm `Bỏ bản chỉnh sửa?`; trước khi đóng drawer chứa form → blur + so sánh giá trị.
- Focus trap + return focus; scrim `fix-overlay`; modal cuộn độc lập, footer cố định.

## 7.20 FgEmptyState / FgErrorState / FgSkeleton
Empty: icon line 40, 1 câu nguyên nhân, CTA. Phân biệt `Không có hồ sơ` (CTA: Tạo đề nghị chi) vs `Không có kết quả với bộ lọc này` (CTA: Xóa lọc) vs `Bạn không có quyền xem mục này` (không CTA, giải thích quyền). Skeleton đúng hình dạng nội dung thật (đừng dùng 3 thanh xám bằng nhau).

## 7.21 FgPagination
`← 1 … 4 [5] 6 … 42 →` + `Hiển thị 1–20 của 812` + page size `20/50/100`. Không dùng infinite scroll cho dữ liệu tiền tệ.

## 7.22 FgDelta
`↑ 8,4% · so với tháng trước`. Tone theo **ý nghĩa**: `phải thu tăng` = danger, `tiền khả dụng tăng` = success. Props `direction`, `goodDirection='up'|'down'`. Không bao giờ chỉ dựa dấu toán học.

## 7.23 FgProgress / FgDebtBar (ngưỡng)
`Thu hồi được 40%` + marker kế hoạch + `Vượt ngưỡng 500 triệu` khi chạm ngưỡng Approval Matrix. Stripe màu = vùng an toàn; vùng vượt = danger 4px + nhãn.

## 7.24 FgInviteUserDialog (quản trị nhân sự — blueprint §XXIX)

**A:** `FgModal` 560, form 3 field: `[Email] [FgCompanyPicker — công ty con] [Vai trò/chức danh]` + helper giải thích: "Nhân sự chưa cần tài khoản — hệ thống gửi email mời, khi nhân sự tạo tài khoản sẽ tự động vào đúng công ty."
**Phân quyền (blueprint §XXIX):** Chủ tịch HĐQT → `FgCompanyPicker` chọn mọi công ty, có action `Ngừng hoạt động`; Giám đốc công ty con → company **khóa cứng vào công ty mình** (readonly, không dropdown), chỉ có action mời + gửi lại, không có `Ngừng hoạt động`.
**St:** idle · sending (loading button) · success (toast `Đã gửi mời tới a@b.com · Chờ kích hoạt`, dialog đóng) · email trùng (`invited`/`active` → error inline: "Email đã được mời vào Công ty A ngày 01/09 · Gửi lại?") · lỗi mạng (retry).
**B:** mời lại = action riêng trong row nhân sự (`Gửi lại mời · lần 2, hết hạn sau 5 ngày`); ngừng hoạt động → `FgConfirmDialog` nêu hậu quả (thu hồi quyền ngay, đang giữ N hồ sơ chờ duyệt → bắt buộc chỉ định người thay thế trước khi khóa).
**AC:** label rõ từng field; email validate inline; focus trap theo §7.19.
**D/!D:** D — bảng nhân sự per công ty: `Tên · Email · Vai trò · FgAccountStatusChip (§3.5) · Ngày tham gia · ⋯`. !D — xóa vật lý tài khoản; dùng danger chip cho `deactivated`.

---

# 8. Screen patterns

## 8.1 Dashboard Giám đốc — 5 tầng, exception-first

```text
SCOPE: [Tất cả công ty ▾]   08/09/2026 08:05   [Bản tin hôm nay ▸]

01 · CẦN XỬ LÝ NGAY        → FgExceptionList (danger/warning) — đặt trên cùng, vì đây là lý do mở app
02 · TIỀN                  → FgKpiCard × 4: Tiền hiện có | Thu hôm nay | Chi hôm nay | Chờ tôi duyệt
03 · DÒNG TIỀN             → Forecast 7/30/60/90 (FgChart.area + FgCashFlowTable) + cảnh báo dưới ngưỡng
04 · NGÂN HÀNG & ĐÁO HẠN   → FgMaturityTable + Dư nợ theo ngân hàng
05 · CHI TIẾT              → Chờ duyệt (top 8) · Phải thu quá hạn · Phải trả đến hạn · Chi theo loại
```
Rule: tầng 01 **không** có chart; tầng 02 tối đa 4 KPI; chart chỉ xuất hiện từ tầng 03.
Nếu không có exception ở mức ≥ 2, thay bằng `FgAlert success: "Không có khoản nào cần xử lý hôm nay"` — im lặng cũng là trạng thái.

## 8.2 Hồ sơ chi tiết (Chi/Thu/Đảo hạn)

```text
FgDrawer (6/12 hoặc full)
├ Header: ← · tiêu đề · FgMoney(full) · FgStatusChip(withOwner) · [⋯]
├ FgTabs: Tóm tắt | Chứng từ | Lịch sử phê duyệt | Dòng tiền liên quan | Audit log
├ Tóm tắt: 7 câu hỏi kiểm soát (§7.14) render thành grid 2 cột
│   Chi cho ai · Bao nhiêu · Để làm gì · Căn cứ HĐ/CT · Nguồn tiền (TK nào) · Số dư sau chi · Ngân sách/kế hoạch
├ Chứng từ: FgDocList
├ Lịch sử: FgApprovalTimeline + FgOpinion
└ FgApprovalActionBar (sticky, hiện khi user là bất kỳ cấp duyệt nào chưa xử lý — fast-track)
```
Mobile: thứ tự `Header → 7 câu hỏi → Chứng từ (mở rộng) → Timeline → Action bar đáy`. Không có tab — tất cả là 1 luồng cuộn để duyệt trong ≤ 3 thao tác.

## 8.3 Danh sách + lọc + hàng chờ duyệt
`Chờ tôi duyệt`: grouping theo `Công ty` có thể tắt; mỗi row hiển thị `số tiền` + `đã chờ N ngày` + tone quá hạn; sort mặc định "chờ lâu nhất"; action inline `Duyệt`/`Xem` chỉ cho cấp hiện tại.

## 8.4 Forecast cash flow
```text
Ngày  | Đầu kỳ | Thu | Chi | Cuối kỳ | Ngưỡng
T2 08/09 | 125,0 | 18,0 | 22,0 | 121,0 | ✓
T4 10/09 | 116,0 |  5,0 | 30,0 |  91,0 | ⚠ < 100
```
Ô `Cuối kỳ` dưới `minBalance` (setting per công ty) → `danger` cell + stripe; chart area tương ứng tô đỏ vùng dưới ngưỡng. Bảng forecast **không scroll ngang** trên mobile → chuyển thành danh sách ngày.

## 8.5 Multi-company chuyển tiền nội bộ
Hồ sơ `Chuyển tiền nội bộ` hiển thị **2 cột đối ứng** bắt buộc: `A: −10,00 tỷ` / `B: +10,00 tỷ` + nhãn `Không tính vào chi phí/doanh thu`. Đây là UI anti-bug, không phải decorative.

---

# 9. Data visualization

## 9.1 Chart palette (thứ tự dùng, không chọn ngẫu nhiên)

```text
c1 #3445C4 brand   · c2 #157F44 success · c3 #B84E0D warning  · c4 #946B04 attention · c5 #1B5FAA info
c6 #7A3FC0         · c7 #0E7A8A         · c8 #545D6D neutral  · c9 #A81E2B danger    · c10 #0F6636
```
Mọi màu ≥ 4.8:1 trên `bg-surface` → đủ cho đường viền chart. **Tối đa 5 series** trong một chart; thứ 6 → gom `Khác` + bảng.

## 9.2 Quy tắc
| Loại | Dùng | Không dùng |
| --- | --- | --- |
| `area` | số dư tiền khả dụng theo ngày (có ngưỡng đỏ) | |
| `line` | dòng tiền forecast 7/30/60/90 | line > 4 series |
| `bar` | thu/chi theo tháng, theo loại | bar 3D |
| `stacked bar` | cơ cấu dòng tiền, chi theo nhóm | stack > 5 phần |
| `donut` | 2–4 thành phần, có tổng ở giữa | donut > 4 lát |
| `pie` | **không dùng** | |

- Trục tung tiền: compact (`tỷ`/`tr`) + đơn vị ghi 1 lần ở trục; không xoay nhãn.
- Ngưỡng (`minBalance`, budget) luôn là **đường nét đứt + nhãn**, không chỉ vùng màu. Ngưỡng cấu hình theo từng công ty.
- Tooltip: `ngày · giá trị full · delta so với kỳ trước`; có `aria-describedby` + bảng dữ liệu thay thế (toggle "Xem dạng bảng").
- Số luôn đọc được mà không cần đo tỷ lệ: mỗi chart chính phải có KPI số phía trên.
- Chart không có legend > 1 dòng; label trực tiếp tốt hơn legend.

---

# 10. Accessibility

**Chuẩn: WCAG 2.2 AA.**

| Yêu cầu | Chuẩn | Trạng thái token |
| --- | --- | --- |
| Text thường | ≥ 4.5:1 | `text.primary/secondary/muted` đạt (16.4 / 9.2 / 5.5) |
| Text lớn ≥ 18px (24px regular) | ≥ 3:1 | ok |
| Icon trạng thái, border đồ họa, dot | ≥ 3:1 | `status.icon` dùng tone 600 → 4.5–6.9 |
| `text.tertiary` #7C8798 | **3.4 — không đạt 4.5** | bị cấm cho thông tin đơn lẻ; chỉ dùng khi có text chính cạnh bên |
| Focus visible | ring 2px `border-focus` + offset 2px, không `outline:none` | bắt buộc mọi interactive |
| Touch target | ≥ 44×44 (mobile), ≥ 32 (desktop) | button `lg` cho mobile |
| Color-only | cấm (§3.4) | icon + nhãn mọi status |
| Keyboard | toàn bộ luồng duyệt hồ sơ thao tác được không chuột: `Tab` → `Enter` mở → `Shift+Tab` tới reason → `Ctrl+Enter` gửi ý kiến → `Alt+D` duyệt / `Alt+X` từ chối (phím tắt cấu hình theo người dùng) | bắt buộc |
| Screen reader | `role="status"` cho chip; `aria-live="polite"` cho toast & số tiền cập nhật; `aria-label` đầy đủ cho số tiền & timeline | |
| Error | inline, gần field, mô tả + cách sửa, không chỉ màu | §7.5 |
| Reduced motion | duration → 0 | §2.7 |
| Zoom 200% / 1280px | layout không vỡ, không mất action | test ở §13.4 |
| Font | Inter có `tnum`; không dùng ảnh cho text; min 13px | |

Mỗi PR UI phải kèm checklist: keyboard path, contrast đã đo, focus order, SR label, grayscale test.

---

# 11. Ngôn ngữ UI (Vietnamese voice & tone)

| Khái niệm | Viết đúng | Không viết |
| --- | --- | --- |
| Hành động duyệt | `Duyệt`, `Duyệt khoản này` | `OK`, `Đồng ý`, `Xác nhận` |
| Từ chối | `Từ chối` + bắt buộc lý do | `Không`, `Hủy` (Hủy = cancel hồ sơ) |
| Yêu cầu thêm | `Yêu cầu bổ sung` / `Yêu cầu chỉnh sửa` | `Reject with comment` |
| Trạng thái chờ | `Chờ Giám đốc duyệt` | `Pending` |
| Phạm vi | `Tất cả công ty`, `Công ty A` | `All companies` |
| Đếm | `12 khoản` `8 hồ sơ` | `12 items` |
| Số tiền | `2,50 tỷ` (vi-VN) | `2.5B`, `125.6 tỷ` |
| Khiếm khuyết dữ liệu | `Chưa có chứng từ` | `N/A` |
| Câu hỏi confirm | `Duyệt khoản 2,50 tỷ cho NCC ABC?` | `Are you sure?` |

- Viết **hoa đầu câu**, không TitleCase giữa câu. Không dùng `!`. Không cảm thán.
- Xưng với Giám đốc: **không xưng tên hệ thống**, dùng câu mệnh lệnh ngắn: `Chờ bạn duyệt`.
- Mỗi cảnh báo = **vật + số + thời hạn + hành động**: `3 khoản chi > 1 tỷ đang chờ bạn duyệt · 8,50 tỷ`.
- Thuật ngữ nghiệp vụ dùng đúng của blueprint: `đảo hạn` (không phải "tái tài trợ"), `nguồn tiền`, `hạn mức`, `dư nợ`, `chứng từ`, `công nợ`.

---

# 12. Hiện thực

## 12.1 CSS variables (trích — file đầy đủ: `packages/ui/src/tokens.css`)

```css
:root, [data-fg-theme="light"] {
  --fg-bg-page:#F7F8FA; --fg-bg-surface:#FFFFFF; --fg-bg-subtle:#F2F4F7; --fg-bg-elevated:#FFFFFF;
  --fg-bg-selected:#EEF1FE; --fg-bg-hover:#F7F8FA; --fg-bg-rail:#262B34; --fg-bg-rail-hover:#3D4451;
  --fg-text-primary:#171A1F; --fg-text-secondary:#3D4451; --fg-text-muted:#5D6673;
  --fg-text-tertiary:#7C8798; --fg-text-disabled:#98A2B3; --fg-text-on-accent:#FFFFFF; --fg-text-link:#3445C4;
  --fg-border-subtle:#EAECF0; --fg-border-default:#E1E5EB; --fg-border-strong:#D6DBE3;
  --fg-border-focus:#3445C4;
  --fg-action-primary:#3445C4; --fg-action-primary-hover:#29379C; --fg-action-danger:#A81E2B;
  --fg-status-success-text:#157F44; --fg-status-success-bg:#E9F7EF; --fg-status-success-border:#CDEBD9;
  --fg-status-warning-text:#B84E0D; --fg-status-warning-bg:#FFF1E8; --fg-status-warning-border:#FFD9BF;
  --fg-status-attention-text:#946B04; --fg-status-attention-bg:#FFF8E1; --fg-status-attention-border:#FFECB3;
  --fg-status-danger-text:#A81E2B; --fg-status-danger-bg:#FEF1F2; --fg-status-danger-border:#FCD9DC;
  --fg-status-info-text:#1B5FAA; --fg-status-info-bg:#EDF4FC; --fg-status-info-border:#D5E6F7;
  --fg-status-neutral-text:#5D6673; --fg-status-neutral-bg:#F2F4F7; --fg-status-neutral-border:#E1E5EB;
  --fg-space-4:16px; --fg-radius-md:8px; --fg-shadow-2:0 4px 12px rgba(23,26,31,.10);
  --fg-z-modal:1100; --fg-motion-fast:140ms;
}
[data-fg-theme="dark"] {
  --fg-bg-page:#0E1116; --fg-bg-surface:#171A1F; --fg-bg-subtle:#12161C; --fg-bg-elevated:#1E232B;
  --fg-text-primary:#E6E9EF; --fg-text-secondary:#C3CAD4; --fg-text-muted:#9AA4B2; --fg-text-link:#BAC6FB;
  --fg-border-default:#2A313B; --fg-action-primary:#6B80F0; --fg-action-primary-text:#0B0E12;
  --fg-status-success-text:#5CCB8A; --fg-status-success-bg:#14261C; --fg-status-success-border:#1F4A32;
}
```

## 12.2 Tailwind

```js
// tokens đều là CSS var → theme.extend chỉ map tên
colors: {
  fg: { bg: { page:'var(--fg-bg-page)', surface:'var(--fg-bg-surface)' },
        text: { primary:'var(--fg-text-primary)', muted:'var(--fg-text-muted)' },
        status: { success:'var(--fg-status-success-text)' } },
}
spacing: fromSizeScale(...), borderRadius: { DEFAULT:'var(--fg-radius-md)' },
boxShadow: { overlay:'var(--fg-shadow-2)' }
```
ESLint/stylelint: **cấm hex literal** trong `apps/**` (rule `fg/no-raw-color`), cấm primitive `fg-n-*` trong screen (rule `fg/no-primitive-in-ui`).

## 12.3 Ant Design v5 ThemeConfig (map 1-1, không override CSS trong screen)

```ts
export const fgTheme: ThemeConfig = {
  token: {
    colorPrimary:'#3445C4', colorInfo:'#1B5FAA', colorSuccess:'#157F44',
    colorWarning:'#B84E0D', colorError:'#A81E2B',
    colorText:'#3D4451', colorTextHeading:'#171A1F', colorTextDescription:'#5D6673',
    colorBorder:'#E1E5EB', colorBorderSecondary:'#EAECF0', colorBgLayout:'#F7F8FA',
    borderRadius:8, controlHeight:40, fontSize:14, fontFamily:'Inter, sans-serif',
    boxShadowTertiary:'0 4px 12px rgba(23,26,31,.10)',
  },
  components: {
    Table:{ headerBg:'#F2F4F7', rowHoverBg:'#F7F8FA', cellPaddingBlock:12, cellFontSize:14 },
    Button:{ fontWeight:500, primaryShadow:'none' },
    Card:{ boxShadow:'none', borderRadiusLG:12 },
    Tag:{ borderRadiusSM:6 },
  },
};
```
Quy tắc: AntD là **engine**, `Fg*` là **API**. Screen chỉ import `Fg*`. `ConfigProvider` đọc theme từ CSS var để dark mode hoạt động.

## 12.4 Contrast đã đo (light)

| Cặp | Ratio | Kết luận |
| --- | --- | --- |
| text.primary / page | 16.4 | AA/AAA |
| text.secondary / surface | 9.8 | AA/AAA |
| text.muted / page | 5.5 | AA |
| white / action.primary | 7.5 | AA |
| white / action.danger | 7.3 | AA |
| success.text / success.bg | 6.4 | AA |
| warning.text / warning.bg | 6.7 | AA |
| attention.text / attention.bg | 6.1 | AA |
| danger.text / danger.bg | 9.0 | AA |
| text.tertiary / page | 3.4 | **hạn chế dùng** (§10) |
| chart c1–c10 / surface | 4.8–7.5 | AA |

## 12.5 Cấu trúc thư mục

```text
packages/ui/
  src/tokens.css  tokens.ts  theme.ts
  src/format/    money.ts date.ts number.ts   # §4
  src/status/    registry.ts                  # §3 (single source of truth, shared với API)
  src/components/Fg*/  index.tsx *.test.tsx *.stories.tsx
packages/icons/   # bộ icon line 1.5px, grid 20, stroke 1.5, 16/20/24
apps/web/src/screens/{dashboard,chi,thu,ngan-hang,vay,dao-han,cong-no,dong-tien,baocao,quantri}
```
`status/registry.ts` được **cả backend và frontend** import → nhãn & tone không bao giờ lệch nhau giữa API, UI, Excel export và notification.

---

# 13. Governance

## 13.1 Figma / Penpot structure

```text
00 Cover · 01 Foundations (Colors/Type/Space/Radius/Shadow/Icon/Grid)
02 Components (Buttons/Inputs/Tables/Cards/Status/Navigation/Feedback/Overlay)
03 Finance Components (Money/KPI/Transaction/ApprovalTimeline/Bank/Loan/Maturity/CashFlow)
04 Patterns (Dashboard/ApprovalDetail/TransactionDetail/Forecast/Report/Settings)
05 Screens (các màn hình production)
06 Docs (Usage, Do/Don't, A11y, Copy)
```
Trong Figma: Variables 3 lớp khớp `tokens.css`; component dùng **Variable, không dùng hex**; alias `Status/*` là duy nhất cho mọi chip.

## 13.2 Naming

`Fg{Noun}` component · `fg-{component}-{part}` class · `{layer}.{group}.{name}` token (tài liệu) ↔ `--fg-{group}-{name}` (CSS).
Không dùng: `FgButtonV2`, `PrimaryBlueButton`, `card-new`.

## 13.3 Thay đổi token

1. Mở issue `DS-xxx` nêu token + lý do + màn hình bị ảnh hưởng.
2. Đo contrast & screenshot 3 màn hình nặng nhất (Dashboard, bảng 300 dòng, detail).
3. Review: Design + 1 FE + 1 BA.
4. Bump version: patch = value mới trong phạm vi thị giác nhỏ; **major = đổi semantic meaning** (ví dụ đổi màu `pending.pgd`).
5. Phát hành `@fingate/ui` + codemod; token cũ giữ alias deprecated ≥ 1 release.

## 13.4 Definition of Done (mọi component/màn hình)

- [ ] Chỉ dùng semantic token; lint `no-raw-color` pass.
- [ ] Đủ state: default/hover/active/focus/disabled/loading/error/empty/partial.
- [ ] Light + dark; contrast đạt; grayscale test; keyboard-only path; SR label cho status & số tiền.
- [ ] Mọi số qua `@fingate/ui/format`; mọi status qua `status/registry`.
- [ ] Responsive 6 breakpoint; mobile không phải desktop thu nhỏ.
- [ ] Storybook có: biến thể, state, Do/Don't, ví dụ dữ liệu thật của FinGate (2,50 tỷ, VCB, đảo hạn).
- [ ] Không có số liệu "Lorem"; dùng dữ liệu demo đúng nghiệp vụ.

## 13.5 Roadmap

| Phase | Phạm vi |
| --- | --- |
| **P0** | `tokens.css` + `status/registry` + `format/money` + `FgButton/Text/Field/Input/Table/StatusChip` → dựng lại Dashboard skeleton |
| **P1** | App shell, FilterBar, Drawer, Modal, Pagination, Tabs, Tooltip, Empty/Skeleton, Toast |
| **P2** | Finance: `FgMoney`, `FgKpiCard`, `FgApprovalTimeline`, `FgApprovalActionBar`, `FgDocList`, `FgOpinion`, `FgMaturityTable`, `FgCashFlowTable`, `FgBankAccountCard`, `FgLoanCard`, `FgGroupAccountPicker` |
| **P3** | Charts + Forecast pattern + ExceptionList + Report + bản tin hàng ngày + **mobile approval (web responsive — bắt buộc theo blueprint §XXIV)** + Quản trị nhân sự (`FgInviteUserDialog`, account status §3.5) |
| **P4** | Dark mode production, 2FA confirm + biometric mobile, print/Excel stylesheet |

**Thứ tự thi công:** Tokens → Core components → Finance components → Dashboard → Approval detail → Transaction detail → phần còn lại. Không bắt đầu bằng 20 màn hình.

---

# Phụ lục A — Bảng tra nhanh

```text
Màu action chính        #3445C4   (hover #29379C)
Nền trang / surface     #F7F8FA / #FFFFFF
Chữ chính / phụ / muted #171A1F / #3D4451 / #5D6673
Border mặc định         #E1E5EB, radius 8, card không shadow
Font                    Inter, body 14/22, số tabular-nums
Space base              4px (4·8·12·16·20·24·32·40·48·64·80)
Sidebar / Header        240 (72) / 64 · content padding 24 · max-width 1440
Status                  icon + nhãn + tone, 12 key, 4 mức cảnh báo đáo hạn
Tiền                    2.500.000.000 ₫ / 2,50 tỷ / −4,00 tỷ / —
Ngày                    DD/MM/YYYY · HH:mm
Focus                   2px #3445C4, offset 2
Touch mobile            44
```

# Phụ lục B — Những gì đã chốt so với bản phác thảo trước

| Mục | Bản trước | Bản 1.0.0 |
| --- | --- | --- |
| Brand | liệt kê 50–900 không có hex | palette hex đầy đủ, hover/press/text chốt |
| Text tokens | `#667085` (4.7) | `secondary #3D4451`, `muted #5D6673` (AA), tertiary bị giới hạn dùng |
| Status | Liệt kê màu | Registry 12 key + tone + icon + quy tắc "ở bàn ai" |
| Đáo hạn | 4 emoji | Maturity ladder ánh xạ token + bắt buộc hiện số ngày |
| Tiền | `125.6 tỷ` | Chuẩn vi-VN `125,6 tỷ`, API format tập trung, quy tắc số âm/zero/`—` |
| Component | 1 danh sách tên | Spec anatomy/variant/state/token/behavior/a11y/Do-Don't |
| Typography | bảng size/weight | scale có line-height, tracking, number scale, max weight |
| Dark mode | mô tả khái niệm | Bộ semantic token dark + status dark đã đo contrast |
| AntD | "nên có wrapper" | `Fg*` API + ThemeConfig map 1-1 + lint cấm raw color |
| A11y | danh sách chung | WCAG 2.2 AA với bảng contrast đo thật + keyboard shortcut luồng duyệt |

# Phụ lục C — Open questions (cần quyết định trước P2)

1. **Ngân hàng Việt Nam** có logo/brand color riêng — được phép dùng ở `FgBankAccountCard` không, hay chỉ dùng text + chữ cái đầu? (đề xuất: không dùng màu thương hiệu ngân hàng, giữ neutral + `FgIcon` chung.)
2. Ngưỡng `minBalance` theo từng công ty: ai thiết lập, thay đổi có vào audit log không? (đề xuất: Kế toán trưởng thiết lập, có audit.)
3. Phông chữ trong **Excel/PDF export** có cần khớp Inter không, hay dùng Arial để file nhẹ?
4. Shortkey `Alt+D` duyệt — có xung đột với trình duyệt/AT không, cần configurable?
5. Mobile app native tương lai có dùng cùng `tokens.json` (style dictionary) không? → nếu có, xuất token từ 1 nguồn `tokens.json` thay vì CSS.
