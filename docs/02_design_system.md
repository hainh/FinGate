App này là hệ thống quản lý tài chính/phê duyệt mà ta vừa đặc tả, design system phải phục vụ 3 thứ: **đọc nhanh → phát hiện rủi ro → ra quyết định**.

Tôi đề xuất một hệ thống theo hướng **Enterprise Financial / Executive Dashboard**, hiện đại, ít màu, mật độ thông tin cao nhưng không rối.

# Design System — Finance Approval Platform

## 1. Design principles

### 01 — Decision first

Mọi màn hình phải trả lời:

> **Tôi cần biết gì? Tôi cần làm gì tiếp theo?**

Không thiết kế dashboard để "trông nhiều dữ liệu".

---

### 02 — Risk is visual hierarchy

Các trạng thái tài chính phải nhận biết được trong < 1 giây:

* 🔴 Critical
* 🟠 Warning
* 🟡 Attention
* 🟢 Healthy
* ⚪ Neutral

Không dùng màu để trang trí.

---

### 03 — Numbers are primary content

Các con số như:

**125.6 tỷ**

phải có visual weight lớn hơn label:

> Tổng tiền hiện có

---

### 04 — Progressive disclosure

Không nhồi tất cả vào một màn hình.

Ví dụ:

```text
Khoản chi 2.5 tỷ
       ↓
Tóm tắt
       ↓
Chi tiết
       ↓
Chứng từ
       ↓
Lịch sử phê duyệt
```

---

### 05 — Desktop first, mobile approval

Dashboard được tối ưu cho desktop.

Mobile tập trung vào:

* Notification
* Xem hồ sơ
* Approve
* Reject
* Request changes

---

# 2. Visual direction

Tôi chọn phong cách:

> **Quiet Enterprise**

Không dùng kiểu SaaS màu mè.

Đặc điểm:

* nền trung tính
* typography rõ
* border nhẹ
* radius vừa phải
* shadow rất ít
* accent màu có kiểm soát
* bảng dữ liệu sạch
* số liệu nổi bật
* khoảng trắng vừa đủ.

Không nên làm kiểu:

> Gradient + glassmorphism + card bay + 5 màu accent.

Nó có thể đẹp khi demo nhưng **rất nhanh trở thành thảm họa khi có 300 dòng giao dịch**.

---

# 3. Design tokens

## Color

### Background

```text
background.page       #F7F8FA
background.surface    #FFFFFF
background.subtle     #F2F4F7
background.elevated   #FFFFFF
```

### Text

```text
text.primary          #171A1F
text.secondary        #667085
text.tertiary         #98A2B3
text.disabled         #B8BEC8
text.inverse          #FFFFFF
```

### Border

```text
border.default        #E4E7EC
border.subtle         #EAECF0
border.strong         #D0D5DD
```

### Brand

Tôi đề xuất một màu brand xanh navy/indigo làm màu chính.

```text
brand.50
brand.100
brand.200
brand.300
brand.400
brand.500
brand.600
brand.700
brand.800
brand.900
```

Ví dụ:

```text
brand.600 = #3448D8
```

Không nên khóa design system vào đúng một hex ngay từ đầu; nên xây **semantic tokens**.

---

# 4. Semantic colors

Đây mới là phần quan trọng.

```text
success
warning
error
info
neutral
```

Ví dụ:

```text
success.600
warning.600
error.600
info.600
neutral.600
```

Mapping:

| Semantic | Ý nghĩa                      |
| -------- | ---------------------------- |
| Success  | Đã hoàn thành / khỏe         |
| Warning  | Cần chú ý                    |
| Error    | Có vấn đề                    |
| Info     | Thông tin                    |
| Neutral  | Không có trạng thái đặc biệt |

### Tài chính

Không nên mặc định:

> tiền vào = xanh, tiền ra = đỏ.

Vì hệ thống có thể có các trường hợp:

* chi phí hợp lệ
* khoản chi bất thường
* khoản thu bị trễ
* khoản vay sắp đáo hạn.

Màu phải biểu diễn **trạng thái/rủi ro**, không phải bản chất giao dịch.

---

# 5. Typography

Tôi khuyên dùng:

## Inter

Cho toàn bộ web application.

```text
Font family: Inter
```

### Type scale

| Token   | Size | Weight |
| ------- | ---: | -----: |
| Display |   32 |    600 |
| H1      |   28 |    600 |
| H2      |   24 |    600 |
| H3      |   20 |    600 |
| H4      |   18 |    600 |
| Body L  |   16 |    400 |
| Body    |   14 |    400 |
| Body S  |   13 |    400 |
| Caption |   12 |    400 |

---

# 6. Financial number typography

Nên có riêng một token:

```text
Numeric / Financial
```

Ví dụ:

**125.60 tỷ**

Không dùng font quá stylized.

Nên dùng:

```text
font-variant-numeric: tabular-nums;
```

để các số trong bảng thẳng hàng.

---

# 7. Spacing system

Dùng base:

**4px**

```text
space-1 = 4
space-2 = 8
space-3 = 12
space-4 = 16
space-5 = 20
space-6 = 24
space-8 = 32
space-10 = 40
space-12 = 48
space-16 = 64
```

---

# 8. Border radius

```text
radius-sm = 6px
radius-md = 8px
radius-lg = 12px
radius-xl = 16px
radius-full = 999px
```

Tôi chọn:

**8px** làm radius mặc định.

---

# 9. Shadows

Rất tiết chế:

```text
shadow-xs
shadow-sm
shadow-md
```

Card thông thường:

> **không cần shadow**

Chỉ cần border.

Shadow chỉ dành cho:

* dropdown
* modal
* popover
* floating panel.

---

# 10. Layout system

Desktop:

```text
┌───────────────────────────────────────────────┐
│ Header                                        │
├──────────────┬────────────────────────────────┤
│              │                                │
│ Sidebar      │ Main content                   │
│ 240px        │                                │
│              │                                │
│              │                                │
└──────────────┴────────────────────────────────┘
```

### Sidebar

```text
width: 240px
collapsed: 72px
```

### Header

```text
height: 64px
```

### Main

```text
padding: 24px
```

---

# 11. Grid

Desktop dùng:

**12-column grid**

Ví dụ Dashboard:

```text
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Cash         │ Receivable   │ Payable      │ Debt         │
│ 125B         │ 35B          │ 42B          │ 180B         │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

Mỗi KPI card:

```text
3 columns
```

---

# 12. Core components

Đây là component library nên xây trước.

## Foundation

```text
Button
IconButton
Typography
Link
Divider
Tooltip
Spinner
Skeleton
```

## Form

```text
Input
NumberInput
MoneyInput
Select
MultiSelect
DatePicker
DateRangePicker
Textarea
Upload
Checkbox
Radio
Switch
```

## Navigation

```text
Sidebar
Header
Breadcrumb
Tabs
Pagination
Menu
Dropdown
```

## Data

```text
Table
DataGrid
StatCard
Metric
Chart
Timeline
ActivityLog
```

## Feedback

```text
Alert
Badge
Status
Toast
Notification
EmptyState
ErrorState
```

## Overlay

```text
Modal
Drawer
Popover
ConfirmDialog
```

---

# 13. Button system

Không nên có 20 loại button.

Chỉ cần:

### Primary

```text
Duyệt
Tạo đề nghị
Lưu
```

### Secondary

```text
Lưu nháp
Xuất Excel
```

### Tertiary

```text
Xem chi tiết
```

### Danger

```text
Từ chối
Hủy
Xóa
```

### Ghost

Cho toolbar.

---

# 14. Approval component

Đây phải là **component đặc trưng của sản phẩm**.

Ví dụ:

```text
┌──────────────────────────────────────────────┐
│ PHÊ DUYỆT                                   │
│                                              │
│ ✓ Kế toán                   Nguyễn A         │
│ │ Đã duyệt 08:32                             │
│ │                                            │
│ ✓ Kế toán trưởng            Nguyễn B         │
│ │ Đã duyệt 09:15                             │
│ │                                            │
│ ● Phó Giám đốc              Bạn              │
│ │ Chờ duyệt                                  │
│ │                                            │
│ ○ Giám đốc                  Nguyễn C         │
│   Chưa thực hiện                             │
└──────────────────────────────────────────────┘
```

Component này dùng ở:

* Chi
* Thu
* Đảo hạn
* Chuyển tiền
* Các nghiệp vụ cần approval khác.

---

# 15. Status component

Không dùng text thuần:

```text
Đã duyệt
```

Dùng:

```text
● Đã duyệt
```

Các trạng thái:

```text
Draft
Pending
In Review
Approved
Rejected
Needs Changes
Processing
Completed
Cancelled
Overdue
```

---

# 16. KPI Card

Một KPI card nên cực kỳ đơn giản:

```text
┌────────────────────────────┐
│ Tổng tiền hiện có       ⋯  │
│                            │
│ 125.6 tỷ                   │
│                            │
│ ↑ 8.4%  so với tháng trước │
└────────────────────────────┘
```

Không nhét:

* icon khổng lồ
* gradient
* chart 5 màu
* 7 dòng text.

---

# 17. Transaction table

Đây sẽ là component xuất hiện rất nhiều.

```text
┌──────────────────────────────────────────────────────────┐
│ Nội dung       Công ty   Người lập   Số tiền   Trạng thái│
├──────────────────────────────────────────────────────────┤
│ Thanh toán NCC A       A         Nam       2.5B     ● Chờ│
│ Mua nguyên liệu        B         Lan       850M     ✓ Duyệt│
│ Trả lãi vay            A         Minh      1.2B     ✓ Đã trả│
└──────────────────────────────────────────────────────────┘
```

### Quy tắc

* Không center toàn bộ table.
* Text → left.
* Number → right.
* Status → left/center tùy layout.
* Ngày → consistent.
* Số tiền → tabular numbers.

---

# 18. Transaction Detail

Click vào giao dịch:

```text
┌─────────────────────────────────────────────┐
│ ← Khoản chi                                 │
│                                             │
│ Thanh toán nhà cung cấp ABC                │
│ 2.500.000.000 VNĐ                           │
│                                             │
│ ● Chờ Giám đốc duyệt                        │
├─────────────────────────────────────────────┤
│ THÔNG TIN                                   │
│                                             │
│ Công ty          ABC                        │
│ Người đề nghị    Nguyễn Văn A               │
│ Ngày thanh toán  15/09/2026                 │
│                                             │
├─────────────────────────────────────────────┤
│ CHỨNG TỪ                                     │
│                                             │
│ 📄 Hop_dong.pdf                             │
│ 📄 Hoa_don.pdf                              │
│                                             │
├─────────────────────────────────────────────┤
│ LỊCH SỬ PHÊ DUYỆT                           │
│                                             │
│ ✓ Kế toán                                   │
│ ✓ Kế toán trưởng                            │
│ ● Giám đốc                                  │
├─────────────────────────────────────────────┤
│                TỪ CHỐI   DUYỆT              │
└─────────────────────────────────────────────┘
```

---

# 19. Approval action bar

Với Giám đốc:

```text
┌─────────────────────────────────────────────┐
│                                             │
│              Từ chối     Yêu cầu sửa  Duyệt │
└─────────────────────────────────────────────┘
```

Action quan trọng nhất phải luôn nằm ở vị trí dễ tìm.

---

# 20. Dashboard visual hierarchy

Tôi sẽ chia Dashboard thành 5 tầng:

```text
01. MONEY
        ↓
02. CASH FLOW
        ↓
03. APPROVALS
        ↓
04. DEBT / MATURITY
        ↓
05. EXCEPTIONS
```

Không phải:

```text
Revenue
Users
Orders
Charts
Pie chart
Bar chart
...
```

Đây là hệ thống tài chính, không phải dashboard marketing.

---

# 21. Exception-first UI

Đây là một điểm tôi đặc biệt khuyên anh đưa vào design system.

Dashboard phải ưu tiên:

> **Cái gì đang bất thường?**

Ví dụ:

### ⚠️ Cần xử lý

```text
3 khoản chi > 1 tỷ đang chờ duyệt

2 khoản vay đáo hạn trong 3 ngày

1 công ty có dòng tiền âm dự kiến

8 khoản phải thu quá hạn
```

Sau đó mới tới:

> Tình hình bình thường.

Điều này giúp giảm đáng kể thời gian Giám đốc phải đọc dashboard.

---

# 22. Chart system

Chỉ dùng một số chart:

### Line chart

Cash flow.

### Bar chart

Thu / chi theo tháng.

### Stacked bar

Cơ cấu dòng tiền.

### Area chart

Cash balance.

### Donut

Chỉ dùng khi thật sự cần composition.

**Không dùng pie chart cho mọi thứ.**

---

# 23. Dark mode

Nên hỗ trợ ngay từ design token.

Không thiết kế dark mode bằng cách:

> đổi background trắng → đen.

Phải có semantic token riêng:

```text
dark.background.page
dark.background.surface
dark.text.primary
dark.text.secondary
dark.border.default
```

Dark mode đặc biệt hữu ích cho:

* làm việc ban đêm
* phòng điều hành
* màn hình lớn.

---

# 24. Responsive

### Desktop ≥ 1440

Full dashboard.

### Laptop 1024–1439

Collapse bớt sidebar.

### Tablet 768–1023

2-column dashboard.

### Mobile < 768

Không cố nhét desktop dashboard.

Chuyển thành:

```text
Tiền hiện có
↓
Cần duyệt
↓
Cảnh báo
↓
Đáo hạn
↓
Dòng tiền
```

---

# 25. Component naming

Nếu triển khai bằng React + Ant Design, tôi khuyên **không sử dụng trực tiếp component AntD ở mọi nơi**.

Sai:

```tsx
<Button />
<Table />
<Tag />
```

Nên có abstraction layer:

```tsx
<AppButton />
<AppTable />
<AppStatus />
<AppMoney />
<AppDate />
<AppModal />
<AppApprovalTimeline />
```

Sau này đổi Ant Design hoặc thay visual style sẽ dễ hơn rất nhiều.

---

# 26. Design token architecture

Trong Figma/Penpot nên chia:

```text
FOUNDATION
│
├── Color
├── Typography
├── Spacing
├── Radius
├── Shadow
├── Icon
│
SEMANTIC
│
├── Background
├── Text
├── Border
├── Brand
├── Status
│
COMPONENT
│
├── Button
├── Input
├── Table
├── Card
├── Modal
├── Badge
├── Approval
│
PATTERN
│
├── Dashboard
├── Approval detail
├── Transaction detail
├── Financial report
└── Cash flow
```

Điểm quan trọng:

**Designer không được dùng Foundation token trực tiếp trong UI nếu đã có Semantic token.**

Ví dụ:

Sai:

```text
Button background = blue-600
```

Đúng:

```text
Button background = action.primary.background
```

Sau này đổi theme sẽ dễ.

---

# 27. Accessibility

Mục tiêu:

**WCAG 2.2 AA**

Đặc biệt:

* contrast đủ cao
* keyboard navigation
* focus state
* không dùng màu làm tín hiệu duy nhất
* screen reader label
* button hit area đủ lớn
* error message rõ ràng.

Ví dụ:

Không nên chỉ:

🔴

Mà nên:

🔴 **Đáo hạn trong 3 ngày**

---

# 28. Component states

Mỗi component phải được thiết kế đầy đủ state ngay từ đầu.

Ví dụ Button:

```text
Default
Hover
Active
Focus
Disabled
Loading
```

Input:

```text
Default
Hover
Focus
Filled
Error
Warning
Disabled
Read-only
```

Table:

```text
Default
Hover
Selected
Loading
Empty
Error
Pagination
```

Nếu bỏ qua phần này, design system sẽ đẹp trong Figma nhưng vỡ khi dev.

---

# 29. Design system MVP

Đừng xây 100 component ngay.

Tôi sẽ chia thành:

### Phase 1 — Foundation

```text
Color
Typography
Spacing
Radius
Shadow
Icon
Grid
```

### Phase 2 — Core

```text
Button
Input
Select
DatePicker
Modal
Drawer
Badge
Status
Table
Pagination
```

### Phase 3 — Finance

```text
Money
KPI
Transaction
Approval Timeline
Cash Flow
Bank Account
Loan
Maturity
Alert
```

### Phase 4 — Patterns

```text
Dashboard
Approval Detail
Transaction Detail
Bank Detail
Loan Detail
Report
```

---

# 30. Cấu trúc Figma/Penpot

Tôi khuyên file thiết kế có cấu trúc:

```text
00 — Cover / Documentation

01 — Foundations
    ├── Colors
    ├── Typography
    ├── Spacing
    ├── Grid
    ├── Icons

02 — Components
    ├── Buttons
    ├── Inputs
    ├── Tables
    ├── Cards
    ├── Status
    ├── Navigation
    ├── Feedback
    └── Overlay

03 — Finance Components
    ├── Money
    ├── KPI
    ├── Transaction
    ├── Approval
    ├── Bank
    ├── Loan
    └── Cash Flow

04 — Patterns
    ├── Dashboard
    ├── Approval
    ├── Transaction
    ├── Reports
    └── Settings

05 — Screens
    ├── Dashboard
    ├── Thu
    ├── Chi
    ├── Ngân hàng
    ├── Vay
    ├── Đảo hạn
    ├── Công nợ
    └── Báo cáo

06 — Documentation
    ├── Usage
    ├── Do / Don't
    └── Accessibility
```

## Một quyết định tôi muốn chốt ngay

**Đừng bắt đầu bằng việc thiết kế 20 màn hình.**

Hãy làm theo thứ tự:

**Tokens → Components → Finance Components → Dashboard → Approval Detail → Transaction Detail → các màn hình còn lại.**
