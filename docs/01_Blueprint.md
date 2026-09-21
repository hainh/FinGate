**“Hệ thống điều hành dòng tiền & phê duyệt tài chính”** cho Ban Giám đốc.

Mục tiêu là mỗi ngày chỉ cần mở web là biết:

* Hôm nay **có khoản thu/chi nào cần duyệt**
* Ai đã lập → Kế toán trưởng kiểm tra/duyệt → Phó TGĐ/GĐ phụ trách duyệt → **Giám đốc duyệt cuối**
* Công ty đang có **bao nhiêu tiền ở từng ngân hàng**
* Hôm nay/ngày tới có **khoản ngân hàng nào đến hạn đảo**
* Dòng tiền 7/30 ngày tới như thế nào
* Khoản nào đã thanh toán, khoản nào chưa
* Ai đang giữ việc, việc nào bị trễ
* Tổng quan tài chính của **tất cả các công ty trong hệ thống**

---

# ĐẶC TẢ HỆ THỐNG WEB QUẢN LÝ PHÊ DUYỆT THU – CHI & DÒNG TIỀN

## I. MỤC TIÊU HỆ THỐNG

Xây dựng hệ thống web nội bộ phục vụ:

1. Quản lý đề nghị thu tiền.
2. Quản lý đề nghị chi tiền.
3. Quản lý quy trình phê duyệt nhiều cấp.
4. Theo dõi số dư tiền mặt và tiền gửi ngân hàng.
5. Theo dõi các khoản vay ngân hàng.
6. Theo dõi các khoản **đảo hạn/đáo hạn ngân hàng**.
7. Theo dõi công nợ phải thu/phải trả.
8. Lập kế hoạch dòng tiền.
9. Theo dõi tình hình tài chính hàng ngày.
10. Tổng hợp dữ liệu của nhiều công ty để Ban Giám đốc quản lý tập trung.

**Nguyên tắc:** Hệ thống phải giúp Giám đốc nhìn được tình hình tài chính trong **1 màn hình**, đồng thời kiểm soát được từng khoản tiền trước khi phê duyệt.

---

# II. CƠ CẤU TỔ CHỨC VÀ PHÂN QUYỀN

Hình thức quản lý: **1 Tập đoàn → nhiều công ty con**. Mỗi công ty con có **bộ nhân sự riêng** (xem thêm mục XXIX – Quản lý nhân sự & tài khoản).

### Cấp 1 – Tập đoàn/Hệ thống

**Chủ tịch HĐQT**

↓

**Giám đốc/Tổng Giám đốc**

↓

### Cấp 2 – Công ty con

Mỗi công ty có bộ nhân sự riêng:

* Nhân viên kế toán
* Kế toán trưởng
* Phó Giám đốc/Giám đốc phụ trách
* Giám đốc/Tổng Giám đốc

---

# III. PHÂN QUYỀN NGƯỜI DÙNG

## 1. Nhân viên kế toán

Có quyền:

* Tạo phiếu thu
* Tạo phiếu chi
* Nhập thông tin khoản phải thu
* Nhập thông tin khoản phải trả
* Nhập lịch thanh toán
* Cập nhật chứng từ
* Theo dõi trạng thái hồ sơ

Không có quyền:

* Tự duyệt khoản chi
* Sửa hồ sơ sau khi đã được cấp trên duyệt nếu không được cấp quyền
* Xóa hồ sơ đã phát sinh

---

## 2. Kế toán trưởng

Có quyền:

* Kiểm tra toàn bộ hồ sơ
* Kiểm tra tính hợp lệ
* Kiểm tra ngân sách
* Kiểm tra công nợ
* Kiểm tra nguồn tiền
* Duyệt kế toán
* Từ chối
* Yêu cầu bổ sung
* Yêu cầu chỉnh sửa
* Ghi ý kiến

Kế toán trưởng **không được tự động bỏ qua các cấp phê duyệt tiếp theo**.

---

## 3. Phó Giám đốc/Giám đốc phụ trách

Có quyền:

* Xem toàn bộ hồ sơ thuộc công ty/phạm vi phụ trách
* Duyệt
* Từ chối
* Yêu cầu bổ sung
* Ghi ý kiến
* Xem lịch sử phê duyệt.

---

## 4. Giám đốc/Tổng Giám đốc

Có quyền cao nhất trong phạm vi điều hành:

* Xem toàn bộ công ty
* Xem toàn bộ khoản thu/chi
* Duyệt khoản chi
* Duyệt khoản thu
* Duyệt đảo hạn ngân hàng
* Xem dòng tiền
* Xem công nợ
* Xem vay ngân hàng
* Xem báo cáo tài chính quản trị
* Xem lịch sử phê duyệt.
* Mời nhân sự của **chính công ty mình** (chỉ mời — không xóa/ngừng tài khoản; xem mục XXIX)

---

## 5. Chủ tịch HĐQT

Cấp phê duyệt cao nhất, áp dụng cho các hồ sơ vượt ngưỡng của Approval Matrix (mặc định: khoản > 5 tỷ, cấu hình được):

* Duyệt cuối các hồ sơ thuộc ngưỡng phải qua HĐQT
* Xem tổng hợp toàn hệ thống (mọi công ty)
* Xem vay ngân hàng, đảo hạn, dòng tiền tập đoàn
* Xem báo cáo tài chính quản trị
* Xem lịch sử phê duyệt
* Nhận thông báo khi có hồ sơ thuộc ngưỡng HĐQT được đẩy lên
* **Quản lý nhân sự toàn hệ thống**: thêm/xóa tài khoản nhân sự của các công ty con bằng email (xem mục XXIX)
* **Cấu hình tài khoản ngân hàng của Tập đoàn** (nhiều tài khoản — xem mục VIII); mọi phiếu thu/chi dùng nguồn tiền tập đoàn phải chỉ rõ tài khoản tập đoàn nào phụ trách
* **Cấu hình Approval Matrix** (ngưỡng tiền → chuỗi cấp duyệt) cho toàn hệ thống/công ty con

Chủ tịch HĐQT **không nhập liệu/tạo phiếu**, chỉ phê duyệt và giám sát.

---

# IV. QUY TRÌNH DUYỆT KHOẢN CHI

Đây là module quan trọng nhất.

Quy trình mặc định:

**Kế toán lập đề nghị**

↓

**Kế toán trưởng kiểm tra & duyệt**

↓

**Phó Giám đốc/Giám đốc phụ trách duyệt**

↓

**Giám đốc duyệt cuối**

↓

**Kế toán thực hiện thanh toán**

↓

**Cập nhật đã thanh toán**

↓

**Đính kèm chứng từ ngân hàng**

## Đổi tài khoản ngay khi duyệt

* Phiếu thu chỉ rõ **tài khoản đích** (nhận tiền); phiếu chi chỉ rõ **tài khoản nguồn** (xuất tiền).
* **Mỗi cấp khi duyệt được đổi tài khoản** đích/nguồn của phiếu, miễn là tài khoản đó nằm trong **phạm vi của công ty lập phiếu** — tài khoản của chính công ty hoặc tài khoản Tập đoàn (mục VIII).
* Thay đổi tài khoản ghi vào lịch sử phê duyệt/audit log (giá trị trước → sau — mục XIX); số dư dự kiến được chuyển từ tài khoản cũ sang tài khoản mới.

## Cơ chế hiển thị và duyệt vượt cấp (fast-track)

* Ngay khi phiếu được gửi đi (khác trạng thái Nháp), **tất cả các cấp trong quy trình đều nhìn thấy phiếu** và có quyền duyệt ngay, không bắt buộc chờ cấp dưới xử lý xong.
* Trang **Chờ tôi duyệt** chỉ liệt kê phiếu mà bước của người dùng là **cấp thấp nhất còn chờ** — tức mọi cấp dưới trong Approval Matrix của phiếu đã duyệt xong. Cấp cao hơn vẫn thấy phiếu (để duyệt vượt cấp) ở các danh sách khác như *Chi chờ duyệt*, danh sách hồ sơ.
* Khi một cấp hoàn tất duyệt, hệ thống **tự động thông báo cho cấp cao hơn kế tiếp** (notification trên web, có thể mở rộng email/mobile theo mục XVIII).
* Trạng thái hồ sơ luôn phản ánh **cấp thấp nhất chưa duyệt** ("đang nằm ở bàn của ai"); nếu có cấp cao hơn đã duyệt trước, hiển thị thêm nhãn "Đã duyệt trước bởi {cấp}".
* Hồ sơ được coi là **Đã duyệt** khi cấp cao nhất theo Approval Matrix đã duyệt; các cấp trung gian chưa xử lý được đánh dấu **bỏ qua** trong lịch sử phê duyệt (không xóa, audit log lưu đầy đủ ai duyệt lúc nào).
* Mọi hành động duyệt đều ghi audit log theo mục XIX.

---

## Trạng thái hồ sơ

Hệ thống phải có trạng thái rõ ràng:

* Nháp
* Chờ Kế toán trưởng
* Chờ Phó Giám đốc
* Chờ Giám đốc
* Đã duyệt
* Đang thanh toán
* Đã thanh toán
* Từ chối
* Yêu cầu bổ sung
* Hủy.

Mỗi trạng thái phải hiển thị rõ **đang nằm ở bàn của ai**.

---

# V. PHIẾU ĐỀ NGHỊ CHI

Khi tạo một khoản chi phải có tối thiểu:

### Thông tin chung

* Công ty
* Bộ phận
* Người đề nghị
* Ngày đề nghị
* Ngày cần thanh toán
* Loại khoản chi
* Nội dung chi
* Đối tượng nhận tiền
* Số tiền
* Loại tiền tệ
* Tài khoản ngân hàng nhận
* Ngân hàng nhận
* Hợp đồng liên quan
* Số hóa đơn
* Mã công nợ
* Nguồn tiền sử dụng
* Tài khoản tập đoàn phụ trách (bắt buộc nếu giao dịch dùng nguồn tiền/qua tài khoản Tập đoàn — xem mục VIII)
* Ghi chú.

### Chứng từ

Cho phép upload:

* Hợp đồng
* Hóa đơn
* Biên bản
* Đề nghị thanh toán
* Báo giá
* Phiếu nhập kho
* Các tài liệu khác.

Có thể upload PDF, Excel, Word, JPG/PNG.

---

# VI. PHÂN LOẠI KHOẢN CHI

Dev xây dựng danh mục để sau này báo cáo được.

Ví dụ:

### 1. Chi hoạt động

* Lương
* Thuê văn phòng
* Điện nước
* Marketing
* Vận chuyển
* Mua hàng
* Nguyên vật liệu
* Dịch vụ
* Chi phí quản lý.

### 2. Chi đầu tư

* Mua đất
* Xây dựng
* Máy móc
* Thiết bị
* Dự án.

### 3. Tài chính

* Trả gốc vay
* Trả lãi vay
* Phí ngân hàng
* Đảo hạn
* Chuyển tiền giữa công ty.

### 4. Khoản khác

Có thể tạo danh mục tùy chỉnh.

---

# VII. QUẢN LÝ KHOẢN THU

Tương tự khoản chi nhưng theo chiều ngược lại.

Theo dõi:

* Khách hàng
* Số tiền dự kiến thu
* Ngày dự kiến thu
* Nội dung
* Hợp đồng
* Hóa đơn
* Công nợ
* Tài khoản đích (nhận tiền)
* Đã thu/chưa thu
* Số tiền thực tế thu
* Ngày thực tế thu.

Đặc biệt cần có:

### Dự kiến thu hôm nay

### Dự kiến thu 7 ngày tới

### Dự kiến thu 30 ngày tới

### Khoản thu quá hạn

---

# VIII. QUẢN LÝ NGÂN HÀNG

Mỗi công ty có thể có nhiều tài khoản ngân hàng.

Ví dụ:

| Công ty   | Ngân hàng   | Số TK | Số dư |
| --------- | ----------- | ----- | ----: |
| Công ty A | Vietcombank | ****  | 10 tỷ |
| Công ty A | BIDV        | ****  |  5 tỷ |
| Công ty B | VietinBank  | ****  | 20 tỷ |

Hệ thống phải cho phép nhập/cập nhật:

* Số dư đầu ngày
* Tiền vào
* Tiền ra
* Số dư cuối ngày
* Tiền bị phong tỏa
* Tiền khả dụng.

## Tài khoản ngân hàng của Tập đoàn

Ngoài tài khoản của từng công ty con, Tập đoàn có **nhiều tài khoản ngân hàng riêng**:

* **Chỉ Chủ tịch HĐQT** được cấu hình (thêm/sửa/khóa) tài khoản tập đoàn: ngân hàng, số TK, tên TK, hạn mức (nếu có), người phụ trách, trạng thái hoạt động.
* **Mỗi phiếu thu/chi phải chỉ rõ tài khoản tập đoàn nào sẽ phụ trách** (trường "Tài khoản tập đoàn phụ trách") khi giao dịch dùng nguồn tiền tập đoàn hoặc thực hiện qua tập đoàn.
* **Cấp duyệt được đổi tài khoản đích (phiếu thu) / tài khoản nguồn (phiếu chi) ngay khi duyệt** (mục IV) — chỉ trong phạm vi công ty của phiếu hoặc tài khoản Tập đoàn; thay đổi vào audit (mục XIX).
* Tài khoản tập đoàn theo dõi số dư như tài khoản công ty: đầu ngày, tiền vào, tiền ra, cuối ngày, phong tỏa, khả dụng — tổng hợp vào Dashboard cấp Tập đoàn.
* Khóa tài khoản tập đoàn → cảnh báo các phiếu đang chờ xử lý có tham chiếu; không cho chọn cho phiếu mới.
* Mọi thao tác cấu hình ghi audit log (mục XIX).

---

# IX. MODULE VAY NGÂN HÀNG

Đây là phần tôi khuyến nghị làm rất kỹ.

Mỗi khoản vay lưu:

* Công ty
* Ngân hàng
* Số hợp đồng tín dụng
* Hạn mức
* Dư nợ
* Ngày giải ngân
* Ngày đáo hạn
* Lãi suất
* Kỳ trả lãi
* Kỳ trả gốc
* Tài sản bảo đảm
* Người phụ trách
* Trạng thái.

---

# X. MODULE "ĐẢO HẠN NGÂN HÀNG"

Đây nên là **một màn hình riêng**.

Ví dụ:

| Ngân hàng | Khoản vay | Dư nợ | Ngày đáo hạn | Cần chuẩn bị | Trạng thái  |
| --------- | --------- | ----: | ------------ | -----------: | ----------- |
| BIDV      | HĐ01      | 20 tỷ | 10/09        |        20 tỷ | ⚠️          |
| VCB       | HĐ02      | 15 tỷ | 15/09        |        15 tỷ | Đã chuẩn bị |
| MB        | HĐ03      | 30 tỷ | 30/09        |        30 tỷ | Chưa xử lý  |

Hệ thống tự động cảnh báo (4 mức cảnh báo, màu theo Design System §3.3, luôn kèm **số ngày cụ thể**):

### 🔴 Đáo hạn hôm nay (danger)

### 🔴 Đáo hạn trong 3 ngày tới (danger)

### 🟠 Đáo hạn trong 4–7 ngày (warning)

### 🟡 Đáo hạn trong 8–30 ngày (attention)

Trên 30 ngày: mức bình thường, chỉ hiển thị số ngày còn lại.

---

# XI. QUY TRÌNH DUYỆT ĐẢO HẠN

Ví dụ:

**Kế toán lập phương án đảo hạn**

Thông tin:

* Khoản vay
* Dư nợ
* Ngày đáo hạn
* Số tiền cần đảo
* Nguồn tiền
* Ngân hàng
* Phương án đảo
* Phí dự kiến
* Lãi suất mới
* Tài sản bảo đảm
* Đề xuất của kế toán.

↓

**Kế toán trưởng kiểm tra**

↓

**Phó Giám đốc phụ trách**

↓

**Giám đốc duyệt**

(Hồ sơ đảo hạn vượt ngưỡng Approval Matrix — mặc định > 5 tỷ — phải qua thêm **Chủ tịch HĐQT** sau Giám đốc.)

↓

**Thực hiện**

↓

**Cập nhật kết quả**

---

# XII. DASHBOARD DÀNH CHO GIÁM ĐỐC

Đây là màn hình quan trọng nhất.

Khi Giám đốc đăng nhập, màn hình đầu tiên phải hiển thị:

## TỔNG QUAN HÔM NAY

### 💰 Tiền hiện có

**Tổng tiền tất cả công ty:  XXX tỷ**

Trong đó:

* Tiền mặt
* Tiền ngân hàng
* Tiền bị hạn chế.

---

### 💵 Thu hôm nay

**Dự kiến thu: XXX tỷ**

* Đã thu
* Chưa thu
* Quá hạn.

---

### 💸 Chi hôm nay

**Tổng cần chi: XXX tỷ**

* Đã duyệt
* Chờ duyệt
* Đã thanh toán
* Chưa thanh toán.

---

### 🏦 Ngân hàng

**Dư nợ: XXX tỷ**

**Đáo hạn 7 ngày: XXX tỷ**

**Đáo hạn 30 ngày: XXX tỷ**

---

# XIII. KHU VỰC "GIÁM ĐỐC CẦN DUYỆT"

Ngay trên Dashboard phải có:

> 🔴 **12 khoản chi đang chờ tôi duyệt — tổng 8,5 tỷ**
>
> 🟠 **1 phương án đảo hạn đang chờ duyệt — 20 tỷ** (tính riêng, không gộp vào tổng chi)

Ví dụ:

| Công ty | Nội dung       | Số tiền | Người lập | Cấp duyệt |
| ------- | -------------- | ------: | --------- | --------- |
| A       | Thanh toán NCC |    2 tỷ | Nguyễn A  | GĐ        |
| B       | Lương          |  1,5 tỷ | Nguyễn B  | GĐ        |
| C       | Đảo hạn        |   20 tỷ | Nguyễn C  | GĐ + HĐQT |

Bấm vào từng khoản → xem toàn bộ hồ sơ → **Duyệt / Từ chối / Yêu cầu bổ sung**.

---

# XIV. "BẢN TIN TÀI CHÍNH HÀNG NGÀY"

Mỗi sáng hệ thống tự động tạo một báo cáo cho Giám đốc.

Ví dụ:

> **BÁO CÁO DÒNG TIỀN – 08/09/2026**
>
> Tổng tiền hiện có: 125 tỷ
> Dự kiến thu hôm nay: 18 tỷ
> Dự kiến chi hôm nay: 22 tỷ
> Dòng tiền thuần: -4 tỷ
>
> Khoản chi chờ Giám đốc duyệt: 8,5 tỷ
> Khoản thu quá hạn: 3,2 tỷ
>
> Đảo hạn:
>
> * Hôm nay: 20 tỷ
> * 3 ngày tới: 35 tỷ
> * 7 ngày tới: 62 tỷ
>
> ⚠️ Cảnh báo: Công ty B có khả năng thiếu tiền 5 tỷ vào ngày 12/09.

Đây sẽ là phần **rất có giá trị đối với anh**.

---

# XV. DỰ BÁO DÒNG TIỀN

Hệ thống cần có:

### Cash Flow Forecast

Theo:

* Hôm nay
* 7 ngày
* 30 ngày
* 60 ngày
* 90 ngày.

Ví dụ:

| Ngày  | Tiền đầu kỳ | Thu | Chi | Dư cuối kỳ |
| ----- | ----------: | --: | --: | ---------: |
| 08/09 |      125 tỷ |  18 |  22 |        121 |
| 09/09 |         121 |  10 |  15 |        116 |
| 10/09 |         116 |   5 |  30 |         91 |

Nếu số dư dự kiến xuống dưới mức tối thiểu → **cảnh báo đỏ**.

---

# XVI. QUẢN LÝ CÔNG NỢ

### Phải thu

* Khách hàng
* Giá trị hợp đồng
* Đã thu
* Còn phải thu
* Hạn thanh toán
* Quá hạn bao nhiêu ngày.

### Phải trả

* Nhà cung cấp
* Giá trị
* Đã trả
* Còn phải trả
* Hạn thanh toán
* Mức độ ưu tiên.

---

# XVII. QUẢN LÝ "KHOẢN CHI ĐỊNH KỲ"

Hệ thống phải cho phép tạo các khoản:

* Lương
* Thuê nhà
* Thuê văn phòng
* Lãi vay
* Phí dịch vụ
* Điện nước
* Bảo hiểm
* Thuế
* Các khoản định kỳ.

Hệ thống tự động nhắc trước:

**7 ngày / 3 ngày / 1 ngày.**

---

# XVIII. HỆ THỐNG CẢNH BÁO

Có notification trên web và có thể mở rộng sang:

* Email
* Telegram
* Zalo OA/API nếu triển khai được
* Mobile push notification.

Các cảnh báo:

🔴 Khoản chi chờ duyệt quá lâu
🔴 Khoản vay sắp đáo hạn
🔴 Số dư ngân hàng thấp
🔴 Khoản phải thu quá hạn
🔴 Khoản chi vượt ngân sách
🔴 Hồ sơ thiếu chứng từ
🔴 Khoản thanh toán đến hạn
🔴 Dòng tiền âm.

---

# XIX. LỊCH SỬ PHÊ DUYỆT – AUDIT LOG

**Bắt buộc phải có.**

Mỗi hồ sơ phải lưu:

* Ai tạo
* Tạo lúc nào
* Ai sửa
* Sửa lúc nào
* Nội dung trước khi sửa
* Nội dung sau khi sửa
* Ai duyệt
* Duyệt lúc nào
* IP/device nếu cần
* Ý kiến khi duyệt
* Ý kiến khi từ chối.

**Không cho phép xóa lịch sử.**

Đặc biệt: sau khi Giám đốc duyệt, dữ liệu không được âm thầm thay đổi.

---

# XX. CƠ CHẾ PHÂN QUYỀN ĐẶC BIỆT

Dev phải xây dựng **Approval Matrix**.

Ví dụ:

| Giá trị khoản chi | Quy trình                               |
| ----------------- | --------------------------------------- |
| < 50 triệu        | KTT → PGĐ                               |
| 50 triệu – 5 tỷ   | KTT → PGĐ → GĐ                          |
| > 5 tỷ            | KTT → PGĐ → GĐ → **Chủ tịch HĐQT** + cảnh báo đặc biệt |

Các ngưỡng này phải **cấu hình được trên hệ thống**, không hard-code.

Lưu ý:

* Matrix định nghĩa các cấp duyệt; hồ sơ luôn do **Nhân viên kế toán lập**, **Kế toán trưởng là cấp kiểm tra & duyệt đầu tiên**.
* Theo cơ chế fast-track (mục IV), mọi cấp trong quy trình đều thấy phiếu và có thể duyệt ngay từ đầu; thứ tự trên chỉ xác định **cấp cao nhất bắt buộc** để hồ sơ được coi là đã duyệt.

---

# XXI. QUẢN LÝ NHIỀU CÔNG TY

Mỗi công ty con có **bộ nhân sự riêng**; tài khoản thuộc công ty nào chỉ thấy dữ liệu công ty đó (trừ cấp Tập đoàn).

Giám đốc có thể chọn:

**Tất cả công ty**

hoặc:

* Công ty A
* Công ty B
* Công ty C
* Công ty D.

Dashboard có thể xem:

### Tổng hợp tập đoàn

hoặc

### Riêng từng công ty.

Đặc biệt phải xử lý được:

**Chuyển tiền giữa các công ty.**

Ví dụ:

Công ty A → Công ty B: 10 tỷ.

Hệ thống phải ghi nhận đồng thời:

* A: tiền ra
* B: tiền vào

và **không tính nhầm thành doanh thu/chi phí**.

---

# XXII. BÁO CÁO

Các báo cáo tối thiểu:

### 1. Báo cáo thu – chi ngày

### 2. Báo cáo thu – chi tháng

### 3. Báo cáo số dư ngân hàng

### 4. Báo cáo công nợ phải thu

### 5. Báo cáo công nợ phải trả

### 6. Báo cáo vay ngân hàng

### 7. Báo cáo đáo hạn

### 8. Báo cáo dòng tiền

### 9. Báo cáo khoản chi theo bộ phận

### 10. Báo cáo khoản chi theo loại

### 11. Báo cáo theo công ty

### 12. Báo cáo khoản chờ duyệt

### 13. Báo cáo hiệu suất xử lý của phòng kế toán.

Tất cả có:

**Export Excel / PDF.**

---

# XXIII. GIAO DIỆN

Tôi đề xuất giao diện **rất đơn giản, thiên về điều hành**, không giống phần mềm kế toán truyền thống.

Menu trái:

```text
DASHBOARD
│
├── 🔴 Chờ tôi duyệt
│
├── THU
│   ├── Khoản thu
│   ├── Dự kiến thu
│   └── Thu quá hạn
│
├── CHI
│   ├── Đề nghị chi
│   ├── Chờ duyệt
│   └── Đã thanh toán
│
├── NGÂN HÀNG
│   ├── Tài khoản
│   ├── Số dư
│   ├── Khoản vay
│   └── Đảo hạn
│
├── CÔNG NỢ
│   ├── Phải thu
│   └── Phải trả
│
├── DÒNG TIỀN
│
├── BÁO CÁO
│
└── QUẢN TRỊ
    ├── Công ty (danh sách công ty con)
    ├── Tài khoản tập đoàn (chỉ Chủ tịch HĐQT)
    ├── Nhân sự & Tài khoản
    └── Approval Matrix (ngưỡng duyệt)
```

---

# XXIV. PHÊ DUYỆT TRÊN ĐIỆN THOẠI

Đây là yêu cầu tôi khuyến nghị **bắt buộc**.

Web phải responsive trên iPhone/iPad.

Giám đốc không cần mở laptop.

Có notification:

> 🔔 Công ty A có khoản chi 2.500.000.000 ₫ đang chờ ông duyệt.

Bấm notification:

**Xem hồ sơ → Duyệt**

Có thể yêu cầu:

* OTP
* PIN
* Face ID/biometric ở ứng dụng nếu sau này phát triển mobile.

---

# XXV. API VÀ TÍCH HỢP

Dev thiết kế hệ thống theo hướng **API-first** để sau này tích hợp:

* Phần mềm kế toán
* ERP
* Ngân hàng
* Hóa đơn điện tử
* CRM
* HRM
* Kho
* Phần mềm bán hàng.

Không nên xây hệ thống đóng.

---

# XXVI. YÊU CẦU BẢO MẬT

Do đây là dữ liệu tài chính, yêu cầu Dev:

* HTTPS
* Mã hóa dữ liệu nhạy cảm
* RBAC – Role Based Access Control
* Phân quyền theo công ty
* Phân quyền theo chức danh
* Phân quyền theo khoản tiền
* 2FA cho tài khoản quản trị
* Audit log
* Backup tự động
* Disaster recovery
* Session timeout
* Không cho tải dữ liệu nếu không có quyền
* Log đăng nhập
* Log thao tác quan trọng.

---

# XXVII. MỘT YÊU CẦU RẤT QUAN TRỌNG: "KHÔNG CHỈ DUYỆT, PHẢI KIỂM SOÁT"

Tôi đề nghị anh yêu cầu Dev thiết kế hệ thống theo nguyên tắc:

> **Mỗi khoản chi phải trả lời được 7 câu hỏi trước khi Giám đốc bấm Duyệt.**

### 1. Chi cho ai?

### 2. Chi bao nhiêu?

### 3. Chi để làm gì?

### 4. Căn cứ vào hợp đồng/chứng từ nào?

### 5. Tiền lấy từ tài khoản nào?

### 6. Sau khi chi thì công ty còn bao nhiêu tiền?

### 7. Khoản này có nằm trong kế hoạch/ngân sách hay không?

---

# XXVIII. DASHBOARD

Nếu là màn hình của **Tổng Giám đốc**

```text
┌──────────────────────────────────────────────┐
│           TỔNG QUAN TÀI CHÍNH               │
├────────────┬────────────┬───────────────────┤
│ TIỀN HIỆN CÓ│ DỰ KIẾN THU│ DỰ KIẾN CHI      │
│  125 TỶ     │  35 TỶ     │  42 TỶ           │
├────────────┴────────────┴───────────────────┤
│          DÒNG TIỀN 30 NGÀY                  │
│             📈 Biểu đồ                      │
├───────────────────────┬─────────────────────┤
│ 🔴 CHỜ TÔI DUYỆT      │ 🏦 ĐẢO HẠN          │
│ 12 khoản              │ Hôm nay: 20 tỷ      │
│ 8,5 tỷ                 │ 7 ngày: 62 tỷ       │
├───────────────────────┼─────────────────────┤
│ 💰 KHOẢN THU QUÁ HẠN  │ 💸 KHOẢN CHI         │
│ 3,2 tỷ                 │ Đến hạn: 15 tỷ      │
└───────────────────────┴─────────────────────┘
```

**Điểm quan trọng nhất:** Giám đốc không nên phải vào 5–7 màn hình để tìm thông tin. Dashboard phải cho thấy ngay **tiền – thu – chi – khoản cần duyệt – khoản vay – đảo hạn – cảnh báo dòng tiền**.

---

# XXIX. QUẢN LÝ NHÂN SỰ & TÀI KHOẢN (TẬP ĐOÀN → NHIỀU CÔNG TY CON)

## 1. Mô hình

* **1 Tập đoàn → nhiều công ty con**; mỗi công ty con có bộ nhân sự riêng.
* Mỗi nhân sự có thể trực thuộc **nhiều công ty**; **chức danh/vai trò** và hạn mức dùng chung, **bộ phận chọn theo từng công ty** (theo mục III).
* **Chủ tịch HĐQT** có quyền thêm/xóa tài khoản nhân sự của **mọi công ty con** bằng email.
* **Giám đốc công ty con** được phân quyền **mời nhân sự của chính công ty mình** (chỉ mời; xóa/ngừng hoạt động tài khoản vẫn thuộc Chủ tịch HĐQT).

## 2. Thêm nhân sự bằng email (không cần tạo tài khoản ngay)

Người có quyền mời nhập:

* Email
* (Các) công ty con sẽ trực thuộc — chọn một hoặc nhiều công ty (với Giám đốc công ty con: trường này **cố định vào công ty mình**, không chọn được công ty khác)
* Chức danh/vai trò

Hệ thống:

* Lưu nhân sự ở trạng thái **Chờ kích hoạt** — chưa cần tạo tài khoản ngay.
* Gửi **email mời** kèm link kích hoạt (link có thời hạn, mặc định 7 ngày, cấu hình được; cho phép gửi lại).
* Mọi thao tác thêm/mời/gửi lại đều ghi audit log (mục XIX).

## 3. Tự động add vào công ty khi tạo tài khoản

* Nhân sự mở email mời → tạo tài khoản (mật khẩu + thiết lập 2FA theo mục XXVI).
* Tài khoản được **tự động gắn vào đúng công ty con** với đúng chức danh đã chỉ định — không cần thao tác gán thủ công.
* Trạng thái chuyển **Chờ kích hoạt → Đang hoạt động**; hệ thống thông báo cho người mời.
* Email đã tồn tại trong hệ thống → báo lỗi trùng, không tạo bản ghi thứ hai.

## 3b. Quản trị cấp lại link đổi mật khẩu cho tài khoản đã kích hoạt

* Quản trị nhân sự (quyền `hr:invite`) sinh được link có chữ ký cho **tài khoản đã hoạt động** — cùng cơ chế và màn `/kich-hoat` như link kích hoạt (phân biệt bằng `mode = reset`).
* Người nhận mở link → chỉ đặt mật khẩu mới; hệ thống **thu hồi mọi phiên đăng nhập cũ**, **giữ nguyên công ty/chức danh**; link chết sau một lần dùng.
* Cấp mới link sẽ vô hiệu link cũ tức thì; admin cũng thu hồi được link đang tồn tại. Mọi thao tác ghi audit log (mục XIX).

## 4. Xóa / điều chỉnh nhân sự

* Xóa tài khoản = **Ngừng hoạt động** (khóa đăng nhập, thu hồi quyền ngay lập tức) — **không xóa vật lý**, bảo toàn audit log theo mục XIX.
* Hồ sơ/phiếu do nhân sự đã ngừng tạo vẫn giữ nguyên, hiển thị tên người lập kèm nhãn `(đã ngừng hoạt động)`.
* Chuyển nhân sự công ty A → công ty B: quyền ở công ty A chấm dứt từ thời điểm hiệu lực; lịch sử ở công ty A bảo toàn; thao tác ghi audit log.
* Nhân sự đang là **cấp duyệt hiện tại** của hồ sơ chờ xử lý → khi ngừng hoạt động/chuyển đi, hệ thống cảnh báo và yêu cầu **chỉ định người thay thế** để hồ sơ không bị treo.

## 5. Trạng thái tài khoản nhân sự

* **Chờ kích hoạt** — đã được mời, chưa tạo tài khoản
* **Đang hoạt động** — đăng nhập được, đầy đủ quyền theo vai trò
* **Ngừng hoạt động** — đã khóa, không đăng nhập được, dữ liệu/audit giữ nguyên

---

# XXX. DỮ LIỆU PHIẾU VÀ HỒ SƠ

## 1. Trường dữ liệu bắt buộc

| Nhóm | Trường dữ liệu |
| ----- | ----- |
| Nhận diện | Công ty; mã phiếu tự sinh; loại phiếu; ngày tạo; người lập; phòng ban |
| Nghiệp vụ | Danh mục; nội dung; đối tượng nộp/nhận; mã số thuế; hợp đồng; dự án; khoản vay liên quan |
| Số tiền | Số tiền; loại tiền; tỷ giá nếu có; thuế; số thực thu/thực chi |
| Nguồn và đích tiền | Quỹ tiền mặt hoặc tài khoản ngân hàng; **phiếu thu: tài khoản đích (nhận tiền); phiếu chi: tài khoản nguồn (xuất tiền)**; **tài khoản tập đoàn phụ trách** (bắt buộc nếu giao dịch dùng nguồn tiền/qua tài khoản Tập đoàn — mục VIII); công ty/đối tác nhận |
| Kế hoạch | Ngày dự kiến thu/chi; mức độ ưu tiên; ngân sách; kỳ thanh toán |
| Kiểm soát | Ý kiến KTT; ý kiến PGĐ; ý kiến GĐ; ý kiến Chủ tịch HĐQT (nếu thuộc ngưỡng HĐQT); lý do vượt cấp (duyệt trước theo fast-track — mục IV); lịch sử trạng thái |
| Thực hiện | Ngày giao dịch thực tế; số tham chiếu ngân hàng; người thực hiện; chứng từ sau thanh toán |

Quy tắc:

* Mã phiếu **tự sinh**, không trùng, không sửa được sau khi gửi; định dạng hiển thị theo Design System (font mono cho mã).
* Trường thuộc nhóm Kiểm soát **không nhập liệu trực tiếp** — hệ thống tự ghi từ quy trình phê duyệt và audit log (mục XIX).
* Phiếu thiếu trường bắt buộc theo loại phiếu → không cho gửi, báo lỗi inline nêu rõ thiếu trường nào (cảnh báo "Hồ sơ thiếu chứng từ" — mục XVIII).
* Tài khoản đích (phiếu thu) / tài khoản nguồn (phiếu chi) **được cấp duyệt đổi ngay khi duyệt**, trong phạm vi công ty của phiếu (hoặc tài khoản Tập đoàn); thay đổi ghi history/audit (mục IV, VIII, XIX).

## 2. Bộ hồ sơ đính kèm

* Phiếu thu hoặc phiếu chi có số và phiên bản.
* Đề nghị thanh toán, hợp đồng, phụ lục, hóa đơn và đơn đặt hàng nếu có.
* Biên bản nghiệm thu, xác nhận khối lượng, bảng đối chiếu công nợ hoặc chứng từ bàn giao.
* Ủy nhiệm chi, giấy báo Có/Báo Nợ, phiếu quỹ hoặc bằng chứng thực hiện giao dịch.
* Khế ước, lịch trả nợ, thông báo giải ngân và hồ sơ tài sản bảo đảm đối với khoản vay.
* Biên bản hoặc hợp đồng đối với công nợ nội bộ và khoản cổ đông vay quỹ.

Quy tắc:

* Chứng từ bắt buộc theo **loại phiếu** (cấu hình được, không hard-code); thiếu → trạng thái cảnh báo trên hồ sơ và trong exception list.
* File sau khi có cấp duyệt tham chiếu → **chỉ thêm, không xóa** (audit — Design System §7.9); mỗi file lưu **phiên bản**.
* Định dạng cho phép: PDF, Excel, Word, JPG/PNG (mục V).
