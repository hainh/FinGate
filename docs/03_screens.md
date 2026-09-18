# FinGate — Screen Inventory (Danh mục màn hình phải làm)

**Phiên bản:** 1.0.0 · **Trạng thái:** Active
**Nguồn suy ra từ:** `01_Blueprint.md` (đặc tả nghiệp vụ) + `02_design_system.md` (token, component, pattern, layout).
**Áp dụng cho:** kế hoạch thi công, estimation, Figma/Penpot `05 Screens`, cấu trúc `apps/web/src/screens/**` (§12.5 design system).

> Tài liệu này **liệt kê màn hình**, không mô tả lại nghiệp vụ. Mỗi màn hình chỉ ghi: route, ai dùng, khối nội dung, component phải có, trạng thái phải xử lý, phase thi công.
> Quy ước: **MÀN HÌNH = có route riêng.** **CHẾ ĐỘ (mode) = cùng một route, đổi tham số** → không dựng màn mới. **OVERLAY = không có route** (xem §20).

---

## 0. Tóm kê số lượng

| Nhóm | Màn hình web | Ghi chú |
| --- | ---:| --- |
| A. Ra nhập & phiên | 6 | auth + 2FA + mật khẩu |
| B. Bảng điều hành & bản tin | 7 | Dashboard 5 tầng, bản tin hàng ngày |
| C. Hàng chờ phê duyệt | 4 | kể cả ủy quyền |
| D. Hồ sơ chi tiết (dùng chung) | 1 | 5 tab + 2 bản desktop/mobile |
| E. CHI | 9 | đề nghị, thanh toán, định kỳ |
| F. THU | 6 | |
| G. NGÂN HÀNG | 9 | tài khoản, số dư, chuyển nội bộ, sao kê |
| H. VAY | 4 | |
| I. ĐẢO HẠN | 5 | module màn hình riêng (§X blueprint) |
| J. CÔNG NỢ | 6 | |
| K. DÒNG TIỀN | 6 | forecast, kế hoạch, ngân sách |
| L. BÁO CÁO | 15 | 1 template + 13 preset + 1 hàng export |
| M. QUẢN TRỊ | 16 | RBAC, Approval Matrix, audit, tích hợp, cá nhân |
| N. Thông báo & cảnh báo | 3 | |
| O. Tìm kiếm | 2 | palette là overlay |
| P. Lỗi & trạng thái hệ thống | 6 | 2 mục là banner/overlay |
| **Cộng mục có ID** | **102** | trừ 4 mục không phải route (SRCH-01, ERR-03, ERR-06, RPT-14) → **≈ 98 route độc lập** |
| Q. Mobile approval-first | 6 | trong đó 3 là biến thể responsive |
| R. Overlay (modal/drawer/bottom-sheet) | 21 | **không phải route** |

**Cảnh báo phạm vi:** 102 mục ≠ 102 lần làm UI. Khoảng **45 mục** chỉ là biến thể của 3 bộ khung chung ở §21 (`Danh sách + FilterBar + FgTable`, `Form hồ sơ`, `Report runner`). Số màn hình thực sự phải design mới: **~24** (Dashboard, hồ sơ chi tiết, đảo hạn, forecast, chi tiết vay, bảng nhập số dư, Approval Matrix, luồng mobile).

**Không bắt đầu bằng 102 màn hình.** Thứ tự thi công ở §22 khớp roadmap §13.5 design system.

---

## 1. Mã màn hình & cột trong bảng

| Cột | Ý nghĩa |
| --- | --- |
| ID | `{MODULE}-{NN}`, dùng làm mã ticket / tên frame Figma / tên route file |
| Màn hình | Tên hiển thị trên page header (đúng ngôn ngữ UI §11, không TitleCase giữa câu) |
| Route | URL thật; là source of truth cho filter (§7.11) → deep-link được từ notification |
| Vai trò | KT = nhân viên kế toán · KTT = kế toán trưởng · PGĐ · GĐ/TGĐ · QT = quản trị |
| Component | `Fg*` phải có (§6–7 design system) |
| St | Các trạng thái dữ liệu/bắt buộc phải xử lý (§7.10/§7.20) |
| Ph | Phase P0–P4 (§22) |
| Nền | `D` desktop ≥1024 · `T` tablet · `M` mobile · `Web` responsive mặc định |

Status workflow dùng **exact key** của §3.1 (`draft`, `pending.ktt`, `pending.pgd`, `pending.gd`, `approved`, `processing`, `paid`, `rejected`, `changes_requested`, `cancelled`, `overdue`). Không tự đặt status mới cho bất kỳ màn hình nào.

---

## 2. Kiến trúc điều hướng (sitemap)

Khớp menu trái §XXIII blueprint + rail §5.1 design system:

```text
/dang-nhap ─┬─ /dashboard                     🔵 GĐ/TGĐ (landing)
            ├─ /cho-toi-duyet                 🔒 badge trên rail
            ├─ /thu            ▸ /du-kien /qua-han /da-thu
            ├─ /chi            ▸ /cho-duyet /da-thanh-toan /dinh-ky
            ├─ /ngan-hang      ▸ /taikhoan /so-du /chuyen-noi-bo /sao-ke
            ├─ /ngan-hang/khoan-vay           → /ngan-hang/dao-han
            ├─ /cong-no        ▸ /phai-thu /phai-tra /doi-chieu
            ├─ /dong-tien      ▸ /ke-hoach /ngan-sach /kich-ban
            ├─ /baocao         ▸ 14 preset
            ├─ /thong-bao /ban-tin
            └─ /quantri        ▸ 13 mục
                     └─ /ho-so/{chi|thu|dao-han|noi-bo}/:id   (drawer hoặc trang)
```

Rail cấp 2 collapse được; `Chờ tôi duyệt` luôn có `FgBadgeCount`. Nội dung cuộn độc lập với rail (§5.1).

---

## 3. Nhóm A — Ra nhập & phiên

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-01 | Đăng nhập | `/dang-nhap` | tất cả | `FgField` `FgInput` `FgPassword` `Checkbox` ("Ghi nhớ đăng nhập" — **mặc định tích**, ADR-19) `FgButton` `FgAlert` | lỗi sai credentials (không tiết lộ field nào sai), lockout sau N lần, loading, rate-limit | P1 | D/T/M |
| AUTH-02 | Xác thực 2 lớp (OTP/PIN) | `/dang-nhap/2fa` | KTT, PGĐ, GĐ, QT | `FgInput` (otp, `inputmode=numeric`, tự fill 1 dòng), resend cooldown 30s | sai, hết hiệu lực, khóa phiên | P4 | D/M |
| AUTH-03 | Quên mật khẩu | `/mat-khau/quen` | tất cả | `FgField` `FgButton` | gửi thành công (luôn trả cùng thông điệp, chống dò email) | P1 | D/M |
| AUTH-04 | Đặt lại mật khẩu | `/mat-khau/dat-lai` | tất cả | `FgField` + strength meter (attention/danger) | link hết hạn, yếu, không khớp | P1 | D/M |
| AUTH-05 | Kích hoạt tài khoản **hoặc đổi mật khẩu** (link có chữ ký, hạn 1 ngày — admin copy gửi, không cần SMTP) | `/kich-hoat` | QT, nhân sự mới, người dùng được cấp lại | form họ tên + đặt mật khẩu lúc kích hoạt; link **đổi mật khẩu** (mode reset, tài khoản đã hoạt động) chỉ hỏi mật khẩu mới rồi thu hồi mọi phiên cũ (một bước; vai trò nhóm 2FA được nhắc bật trong PREF-01 sau đăng nhập) | token hết hạn/sai chữ ký/đã thu hồi/đã dùng (FG-AUTH-009) | P2 | D/M |
| AUTH-06 | Hết phiên — mở khóa | `/hoa` (khóa màn hình, không có route lịch sử) | tất cả | overlay full, hiện `đang giữ hồ sơ dở` + nút khôi phục | idle timeout (§XXVI), giữ bản nháp form. **Chỉ xảy ra khi bỏ chọn "Ghi nhớ đăng nhập"** (ADR-19) | P2 | D/M |

**Bắt buộc mọi màn A:** không log mật khẩu/OTP, `FgText` không hiển thị email đầy đủ của người khác, có link "Không phải bạn? — Đăng xuất".

---

## 4. Nhóm B — Bảng điều hành & bản tin

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DASH-01 | Dashboard — Tổng quan tài chính | `/dashboard` | GĐ, TGĐ, PGĐ | 5 tầng §8.1: `FgExceptionList`, `FgKpiCard×4`, `FgChart.area`, `FgCashFlowTable`, `FgMaturityTable`, `FgTable` (top 8), `FgScopeSwitcher` | loading skeleton đúng hình, stale (`Cập nhật 07:30` attention nếu >24h), partial (công ty X chưa đồng bộ → `FgAlert`), empty = "Không có khoản nào cần xử lý hôm nay" (success), offline | **P0** | D/T |
| DASH-02 | Bảng điều hành kế toán | `/bang-dieu-hanh` | KT, CV, KTT | hàng chờ theo vai trò, `FgTable`, SLA breach, hồ sơ thiếu chứng từ, `FgProgress` (KH hôm nay) | như DASH-01 + `changes_requested` nổi bật | P2 | D/T |
| DASH-03 | Bản tin tài chính hàng ngày | `/ban-tin/ngay` | GĐ, PGĐ, KTT | bản **chỉ đọc** (§XIV blueprint): KPI + forecast + đáo hạn 3 mức + cảnh báo thiếu tiền; `FgButton` [In] [Xuất PDF] [Chia sẻ] | chưa sinh bản tin (hệ thống đang chạy), sinh lỗi, dữ liệu nguồn thiếu | P3 | D/M |
| DASH-04 | Lịch sử bản tin | `/ban-tin` | GĐ, KTT | `FgTable` theo ngày, search | rỗng, ngày nghỉ/lễ | P3 | D |
| DASH-05 | Trung tâm "Cần xử lý" | `/can-xu-ly` | GĐ, KTT, CV | Nhóm: *Cần bổ sung (bị trả về)* — hồ sơ `changes_requested` do tôi lập; *Hồ sơ thiếu chứng từ*; *Quá hạn xử lý*; *Đang chờ bạn duyệt*. `FgExceptionList` đầy đủ (không giới hạn 6) | 0 mục = success state | P2 | D/M |
| DASH-06 | Tổng quan theo công ty | `/dashboard/cong-ty/:id` | GĐ, PGĐ | **cùng khung DASH-01**, scope ghim 1 công ty | công ty bị tạm dừng | P2 | D |
| DASH-08 | Trang "Tiền hôm nay" (cash position nhanh) | `/hom-nay` | GĐ mobile | 4 khối dọc theo §5.4 breakpoint `<768` | như DASH-01 bản rút gọn | P4 | M |

**Chế độ của DASH-01 — không dựng màn mới:** scope `Tất cả công ty` / từng công ty (DASH-06); `?view=ops` cho phòng điều hành ≥1920px (font +1 nấc, dark bắt buộc, tự refresh); density; dark/light.

---

## 5. Nhóm C — Hàng chờ phê duyệt

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APPR-01 | Chờ tôi duyệt | `/cho-toi-duyet` | CV, KTT, PGĐ, GĐ | `FgFilterBar`, `FgTable` sort mặc định *chờ lâu nhất*, group `Công ty` tắt được, `FgStatusChip(withOwner)`, bulk bar (`Đã chọn 12 · Tổng 18,40 tỷ · [Duyệt hàng loạt]`); chỉ hiện phiếu mà bước của tôi là **cấp thấp nhất còn chờ** (mọi cấp dưới trong Matrix đã duyệt xong) — duyệt vượt cấp dùng các danh sách khác | 0 hồ sơ, hồ sơ bị người khác duyệt (409), pending quá SLA → `overdue` chip thứ 2 | P1 | D/T/M |
| APPR-02 | Tôi đã duyệt | `/toi-da-duyet` | mọi cấp duyệt | `FgTable` + `FgApprovalTimeline` compressed, bộ kết quả theo ý kiến | rỗng theo khoảng ngày | P2 | D |
| APPR-03 | Hồ sơ bị trả về / cần bổ sung | `/can-bo-sung` | KT, CV | `FgTable` filter `changes_requested`, hiển thị yêu cầu + người yêu cầu + còn hạn? | hết hạn phản hồi | P2 | D/M |
| APPR-04 | Ủy quyền phê duyệt | `/uy-quyen` | PGĐ, GĐ, QT | `FgUserPicker`, `FgDateRange`, `FgTable` đang/đã hết hiệu lực, `FgConfirmDialog` | trùng khoảng, tự ủy quyền cho mình, cấp dưới vượt hạn mức | P3 | D |

> APPR-04 không có trong blueprint — thêm vì Giám đốc đi công tác là lý do số 1 khiến hàng chờ đứng. Cần xác nhận (see §24 Q-05).

---

## 6. Nhóm D — Hồ sơ chi tiết (dùng chung cho CHI · THU · ĐẢO HẠN · CHUYỂN NỘI BỘ)

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DOC-01 | Hồ sơ (drawer desktop / trang mobile) | `/ho-so/:loai/:id` — `loai` ∈ chi · thu · dao-han · noi-bo | tất cả | §8.2: header (`FgMoney full`, `FgStatusChip withOwner`) + `FgTabs`(5) + `FgApprovalTimeline` + `FgOpinion` + `FgDocList` + `FgApprovalActionBar` (chỉ hiện khi user là cấp duyệt hiện tại) | loading, 403, đã bị duyệt (409 alert + reload), thiếu chứng từ bắt buộc → action bar cảnh báo, read-only sau khi qua cấp | **P2** | D/T/M |

5 tab bắt buộc:

| Tab | Nội dung | Component |
| --- | --- | --- |
| `Tóm tắt` | **6 câu hỏi kiểm soát** (§XXVII blueprint, §7.14 DS) render grid 2 cột: chi cho ai · bao nhiêu · để làm gì · căn cứ HĐ/chứng từ · nguồn tiền (TK + số dư trước/sau) · ngân sách/kế hoạch | `FgStatRow`, `FgMoney`, `FgDebtBar` |
| `Chứng từ` | `FgDocList` + upload, preview PDF inline, lightbox ảnh | `FgUpload` |
| `Lịch sử phê duyệt` | timeline + toàn bộ ý kiến + thời gian chờ từng cấp | `FgApprovalTimeline`, `FgOpinion` |
| `Dòng tiền liên quan` | ảnh hưởng số dư TK, khoản đối ứng, dư trước/sau | `FgCashFlowTable`, `FgBankAccountCard` |
| `Audit log` | diff trước/sau của từng lần sửa, IP/device | `FgTable`, `FgTimeline` |

Chuyển tiền nội bộ: tab `Tóm tắt` **bắt buộc** 2 cột đối ứng `A: −10,00 tỷ / B: +10,00 tỷ` + nhãn "Không tính vào chi phí/doanh thu" (§8.5) — UI anti-bug.

---

## 7. Nhóm E — CHI (module quan trọng nhất)

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CHI-01 | Đề nghị chi (danh sách) | `/chi` | KT, CV, KTT, PGĐ, GĐ | `FgFilterBar`, `FgTable` (column order §7.10), column chooser, density, `Lưu view` | loading/empty/error/partial, `draft` của mình, vượt hạn mức → marker | P1 | D/T |
| CHI-02 | Tạo đề nghị chi | `/chi/moi` | KT, CV | form §V blueprint: `FgCompanyPicker` `FgUserPicker` `FgSelect`(loại chi) `FgMoneyInput` `FgDatePicker` `FgDocList` `FgField`; panel phụ "dư khả dụng sau khi chi" | autosave draft, lỗi submit (focus field đầu tiên), warning vượt ngân sách/hạn mức, thiếu chứng từ bắt buộc, rời trang khi dirty | P2 | D/T |
| CHI-03 | Sửa đề nghị chi | `/chi/:id/sua` | KT, CV (chỉ khi `draft`/`changes_requested`, hoặc được cấp quyền) | khung CHI-02 | bị khóa vì đã qua cấp (`readOnly`), diff với bản đã duyệt | P2 | D/T |
| CHI-04 | Chi chờ duyệt | `/chi/cho-duyet` | KTT, PGĐ, GĐ | **khung CHI-01** + filter ghim `pending.*` | như APPR-01 | P1 | D |
| CHI-05 | Chi đã duyệt — chờ thanh toán | `/chi/cho-thanh-toan` | KT, CV | `FgTable` (`approved`), CTA `Thực hiện thanh toán` | quá hạn thanh toán → `overdue` | P2 | D |
| CHI-06 | Thực hiện thanh toán | `/chi/:id/thanh-toan` | KT | chọn nguồn tiền (`FgBankAccountCard` + số dư khả dụng), ngày thực chi, số thực trả, upload chứng từ ngân hàng | số dư không đủ (error), trùng ủy nhiệm chi, hoàn tất → `paid` | P2 | D/M |
| CHI-07 | Đã thanh toán | `/chi/da-thanh-toan` | mọi vai trò | `FgTable` filter `paid` + cột chứng từ ngân hàng | thiếu chứng từ sau thanh toán → attention | P2 | D |
| CHI-08 | Khoản chi định kỳ | `/chi/dinh-ky` | KT, KTT | `FgTable` + `FgProgress` nhắc 7/3/1 ngày (§XVII), cột kỳ kế tiếp | sắp đến hạn (attention), đã phát sinh kỳ này, bị tạm dừng | P3 | D |
| CHI-09 | Tạo / sửa khoản chi định kỳ | `/chi/dinh-ky/moi`, `/chi/dinh-ky/:id/sua` | KT, KTT | form + `FgSelect`(chu kỳ) + `FgDateRange`(hiệu lực) + preview lịch phát sinh 12 kỳ | kỳ va ngày nghỉ, xung đột chu kỳ | P3 | D |

---

## 8. Nhóm F — THU

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| THU-01 | Khoản thu (danh sách) | `/thu` | KT, CV, KTT, GĐ | `FgFilterBar`, `FgTable` (§7 column order) | loading/empty/error, `draft` | P1 | D/T |
| THU-02 | Tạo / sửa khoản thu | `/thu/moi`, `/thu/:id/sua` | KT, CV | form §VII: khách hàng, dự kiến thu, ngày, HĐ, hóa đơn, công nợ, TK nhận, nội dung | autosave, validate HĐ/công nợ | P2 | D/T |
| THU-03 | Dự kiến thu | `/thu/du-kien` | KTT, PGĐ, GĐ | `FgSegmented` [Hôm nay · 7 ngày · 30 ngày] + `FgTable` + `FgKpiCard` tổng | chưa có KH nào trong khoảng | P2 | D/M |
| THU-04 | Thu quá hạn | `/thu/qua-han` | KTT, GĐ | `FgTable` + `FgStatusChip strong` overdue + cột "quá hạn N ngày" + CTA `Đôn đốc` | 0 khoản (success) | P2 | D/M |
| THU-05 | Xác nhận đã thu | `/thu/:id/xac-nhan` | KT | ngày thực thu, số thực thu (`FgMoneyInput`), TK nhận, chứng từ | lệch dự kiến (delta), thu một phần nhiều lần | P2 | D/M |
| THU-06 | Lịch sử thu / các lần thu một phần | `/thu/:id/lan-thu` | KT, CV | `FgTable` + `FgProgress` (đã thu / giá trị HĐ) | còn nợ, thu vượt | P3 | D |

---

## 9. Nhóm G — NGÂN HÀNG

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BANK-01 | Tài khoản ngân hàng | `/ngan-hang/taikhoan` | KT, KTT, QT | `FgTable` (công ty, NH, số TK mask, loại tiền, trạng thái), `FgBankAccountCard` grid view | TK bị đóng, chưa có số dư hôm nay | P1 | D |
| BANK-02 | Tạo / sửa tài khoản | `/ngan-hang/taikhoan/moi` | KTT, QT | form + `FgSwitch`(hiển thị dashboard) + `minBalance` per TK (đề xuất Q-02) | trùng số TK, đổi ngưỡng có audit | P2 | D |
| BANK-03 | Chi tiết tài khoản | `/ngan-hang/taikhoan/:id` | KT, KTT, GĐ | KPI (`FgMoney`), `FgChart.line` số dư 90 ngày + ngưỡng nét đứt, bảng giao dịch | stale (chưa nhập hôm nay), thiếu sao kê | P2 | D/T |
| BANK-04 | Nhập số dư đầu ngày / cash position | `/ngan-hang/so-du` | KT, CV | **bảng nhập liệu dày** §VIII: đầu ngày · vào · ra · cuối ngày · phong tỏa · khả dụng; tự kiểm `đầu+vào−ra = cuối` | lệch (error inline per dòng), đã khóa ngày, đang nhập dở (autosave), nút "tính lại" | P2 | D |
| BANK-05 | Lịch sử số dư theo ngày | `/ngan-hang/so-du/lich-su` | KTT, GĐ | `FgDateRange` + `FgTable` + export | khoảng chưa nhập | P3 | D |
| BANK-06 | Tiền bị hạn chế / phong tỏa | `/ngan-hang/hoa-tien` | KTT | `FgTable` (lý do, ngày gỡ), alert trên KPI "Tiền hiện có" | hết hiệu lực | P3 | D |
| BANK-07 | Chuyển tiền nội bộ giữa công ty | `/ngan-hang/chuyen-noi-bo` | KT, KTT, GĐ | `FgTable` + DOC-01 loại `noi-bo` (2 cột đối ứng) | một chiều chưa xác nhận → attention | P3 | D/M |
| BANK-08 | Tạo chuyển tiền nội bộ | `/ngan-hang/chuyen-noi-bo/moi` | KT | 2 `FgBankAccountCard` đối ứng, số tiền, tỷ lệ phí, ngày | số dư nguồn không đủ | P3 | D |
| BANK-09 | Sao kê / nhập khẩu giao dịch | `/ngan-hang/sao-ke` | KT, CV | `FgUpload` (CSV/OFX/xlsx), bảng đối chiếu khớp/giải, `FgProgress` | file lỗi format, dòng trùng, chưa map loại | P4 | D |

> **Q-01 (mở):** logo/màu thương hiệu ngân hàng — design system đề xuất **không dùng** màu brand NH, giữ neutral + `FgIcon` chung. Chốt trước khi làm BANK-01/03.

---

## 10. Nhóm H — VAY NGÂN HÀNG

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LOAN-01 | Danh sách khoản vay | `/ngan-hang/khoan-vay` | KTT, PGĐ, GĐ | `FgTable` (công ty, NH, HĐTD, hạn mức, dư nợ, đáo hạn, lãi suất, trạng thái) + `FgKpiCard` tổng dư nợ | sắp đáo hạn (tone §3.3), HĐ hết hiệu lực | P2 | D/T |
| LOAN-02 | Chi tiết khoản vay | `/ngan-hang/khoan-vay/:id` | KTT, GĐ | §IX: `FgLoanCard` header, `FgDebtBar` (dư nợ/hạn mức), lịch trả gốc/lãi, TSĐB, người phụ trách, `FgChart.line` dư nợ, liên kết đảo hạn | lãi suất thay đổi, gia hạn, tất toán | P2 | D/T |
| LOAN-03 | Tạo / sửa khoản vay | `/ngan-hang/khoan-vay/moi` | KT, KTT | form + `FgMoneyInput` (hạn mức, dư nợ) + lãi suất 2 decimal + `FgSelect`(kỳ trả lãi/gốc) + TSĐB | validate ngày giải ngân ≤ đáo hạn, trùng HĐTD | P3 | D |
| LOAN-04 | Lịch nghĩa vụ trả nợ (gốc + lãi + phí) | `/ngan-hang/khoan-vay/lich-tra` | KTT, KT, GĐ | `FgTable` theo ngày + `FgCashFlowTable` gộp vào forecast | nhóm quá hạn, nhóm 7/30 ngày | P3 | D/T |

---

## 11. Nhóm I — ĐẢO HẠN (màn hình riêng theo §X)

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RENEW-01 | Bảng đảo hạn | `/ngan-hang/dao-han` | KTT, PGĐ, GĐ | `FgMaturityTable` + maturity ladder §3.3 (4 mức, luôn hiện **số ngày cụ thể**), filter theo NH/công ty, KPI 4 ngưỡng (hôm nay/3/7/30) | chưa chuẩn bị (attention), đã chuẩn bị (success), đang xử lý (info), dữ liệu vay chưa đồng bộ | **P2** | D/T |
| RENEW-02 | Lập phương án đảo hạn | `/ngan-hang/dao-han/phuong-an/moi` | KT | form §XI: khoản vay, dư nợ, ngày đáo hạn, số cần đảo, nguồn tiền, phí dự kiến, lãi suất mới, TSĐB, đề xuất | thiếu nguồn tiền, phí vượt ngưỡng | P2 | D/T |
| RENEW-03 | Chi tiết phương án đảo hạn | → dùng `DOC-01` (`type=dao-han`) + route `/ngan-hang/dao-han/:id` | KTT, PGĐ, GĐ | timeline rút gọn (KT→KTT→PGĐ→GĐ), `FgApprovalActionBar` | 409, yêu cầu bổ sung | P2 | D/M |
| RENEW-04 | Cập nhật kết quả thực hiện | `/ngan-hang/dao-han/:id/ket-qua` | KT | HĐ mới, ngày giải ngân lại, lãi suất thực tế, phí thực tế, chứng từ | rejected, một phần (đảo 15/20 tỷ) | P3 | D |
| RENEW-05 | Bảng "tiền cần chuẩn bị cho 30 ngày tới" | `/ngan-hang/dao-han/chuan-bi` | KTT, GĐ | `FgCashFlowTable`: đáo hạn + chi định kỳ + threshold vs số dư khả dụng → chỗ thiếu | khoảng trống dự báo, phương án đang chờ duyệt | P3 | D/T |

---

## 12. Nhóm J — CÔNG NỢ

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEBT-01 | Phải thu | `/cong-no/phai-thu` | KT, KTT, GĐ | `FgTable` §XVI (khách hàng, giá trị HĐ, đã thu, còn phải thu, hạn, quá hạn N ngày) + aging | 0 dòng, đối chiếu lệch | P2 | D/T |
| DEBT-02 | Chi tiết phải thu | `/cong-no/phai-thu/:id` | KT, KTT | `FgTimeline` các lần thu, HĐ liên quan, `FgProgress` thu hồi được %, `FgDebtBar` | vượt ngưỡng đôn đốc | P3 | D |
| DEBT-03 | Phải trả | `/cong-no/phai-tra` | KT, KTT, GĐ | `FgTable` + cột **mức độ ưu tiên** (`FgSelect` inline), nhóm theo NCC | quá hạn, đang chờ duyệt thanh toán | P2 | D/T |
| DEBT-04 | Chi tiết phải trả | `/cong-no/phai-tra/:id` | KT, CV | lịch sử thanh toán, hồ sơ chi liên quan, chứng từ | lệch số đã trả | P3 | D |
| DEBT-05 | Đối chiếu công nợ / tuổi nợ | `/cong-no/doi-chieu` | KTT | `FgTable` ma trận aging (chưa đến hạn / <30 / 30–60 / 60–90 / >90), xuất Excel | lệch giữa 2 nguồn dữ liệu | P3 | D |
| DEBT-06 | Lập lịch thanh toán cho NCC | `/cong-no/phai-tra/ke-hoach` | KTT, GĐ | `FgTable` xếp hạng theo ưu tiên + ngày + nguồn tiền, "gợi ý phương án" (đề xuất CV) | tổng vượt số dư khả dụng → danger | P4 | D |

---

## 13. Nhóm K — DÒNG TIỀN

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CASH-01 | Dự báo dòng tiền | `/dong-tien` | GĐ, KTT | §XV + §8.4: `FgSegmented` [7/30/60/90] + `FgChart.area` (ngưỡng đỏ) + `FgCashFlowTable` (đầu kỳ·thu·chi·cuối kỳ·ngưỡng) | ô dưới ngưỡng → danger cell + stripe, forecast chưa đủ nguồn, stale | **P3** | D/T |
| CASH-02 | Thực thu – thực chi ngày | `/dong-tien/thuc-te` | KT, KTT | `FgCashFlowTable` + đối chiếu forecast vs thực tế (`FgDelta` tone theo ý nghĩa) | ngày chưa khóa sổ | P3 | D |
| CASH-03 | Kế hoạch dòng tiền | `/dong-tien/ke-hoach` | KTT, GĐ | form bảng (nhập theo ngày/tuần), trạng thái bản nháp → duyệt kế hoạch, so sánh KH/TH | nhiều phiên bản kế hoạch, deviated | P4 | D |
| CASH-04 | Ngân sách theo bộ phận / loại chi | `/dong-tien/ngan-sach` | KTT, GĐ | `FgTable` + `FgDebtBar` (đã dùng / KH) + vượt ngưỡng Approval Matrix | vượt ngân sách → danger + cảnh báo §XVIII | P4 | D |
| CASH-05 | Kịch bản giả định (what-if) | `/dong-tien/kich-ban` | GĐ | thêm/giả định dòng tiền, so sánh 2–3 kịch bản trên 1 `FgChart.line` (≤4 series), không ghi vào dữ liệu thật | chưa có giả định | P4 | D |
| CASH-06 | Cảnh báo dòng tiền âm | `/dong-tien/canh-bao` | GĐ, KTT | `FgExceptionList` + danh sách ngày dự kiến thiếu tiền + nguyên nhân | không có cảnh báo (success) | P3 | D/M |

---

## 14. Nhóm L — BÁO CÁO (§XXII)

**Kiến trúc: 1 màn hình khung + 14 preset.** Không design 14 layout khác nhau.

| ID | Màn hình | Route | Vai trò | Component | St | Ph |
| --- | --- | --- | --- | --- | --- | --- |
| RPT-00 | Thư viện báo cáo | `/baocao` | mọi vai trò | lưới card preset + `FgFilterBar` gần đây nhất, `Lưu view` | rỗng quyền | P3 |
| RPT-01 | Thu – chi ngày | `/baocao/thu-chi/ngay` | KTT, GĐ | `FgCashFlowTable` + KPI | chưa có dữ liệu ngày | P3 |
| RPT-02 | Thu – chi tháng | `/baocao/thu-chi/thang` | KTT, GĐ | `FgChart.bar` + `FgTable` + so sánh kỳ trước | | P3 |
| RPT-03 | Số dư ngân hàng | `/baocao/so-du-ngan-hang` | KTT, GĐ | `FgTable` theo TK/công ty + `FgChart.stacked` | | P3 |
| RPT-04 | Công nợ phải thu | `/baocao/cong-no-phai-thu` | KTT | aging `FgTable` | | P3 |
| RPT-05 | Công nợ phải trả | `/baocao/cong-no-phai-tra` | KTT | `FgTable` | | P3 |
| RPT-06 | Vay ngân hàng | `/baocao/vay-ngan-hang` | GĐ, KTT | `FgTable` + `FgDebtBar` theo NH | | P3 |
| RPT-07 | Đáo hạn | `/baocao/dao-han` | GĐ, KTT | `FgMaturityTable` + nhóm 4 mức | | P3 |
| RPT-08 | Dòng tiền | `/baocao/dong-tien` | GĐ | `FgChart.area` + bảng | | P3 |
| RPT-09 | Chi theo bộ phận | `/baocao/chi-bo-phan` | GĐ, KTT | `FgChart.bar` (≤5 series) + `FgTable` | | P3 |
| RPT-10 | Chi theo loại | `/baocao/chi-loai` | GĐ, KTT | `FgChart.donut` (≤4 lát, tổng giữa) + bảng | | P3 |
| RPT-11 | So sánh theo công ty | `/baocao/theo-cong-ty` | TGĐ | `FgTable` đối chiếu + `FgChart.stacked` | công ty mới, chưa có kỳ so sánh | P3 |
| RPT-12 | Khoản chờ duyệt (aging phê duyệt) | `/baocao/cho-duyet` | TGĐ, KTT | `FgTable` theo cấp + N ngày chờ | | P3 |
| RPT-13 | Hiệu suất phòng kế toán | `/baocao/hs-ketoan` | KTT, TGĐ | `FgTable` (người · số hồ sơ · thời gian TB · quá SLA · bị trả về) | mẫu < 10 hồ sơ → không xếp hạng | P4 |
| RPT-14 | Bộ lọc + Export mọi báo cáo | (trong từng RPT-xx) | mọi vai trò | `FgFilterBar` + [Xuất Excel] [Xuất PDF] [In] | `partial` (1 công ty chưa đồng bộ), **không có quyền tải → ẩn nút + giải thích** (§XXVI) | P3/P4 |

Mọi màn L: số liệu qua `@fingate/ui/format` (cùng hàm với Excel §4.2), có "Xem dạng bảng" cho chart (§9.2), footer ghi *scope · thời điểm · người xuất · lần cập nhật*.

---

## 15. Nhóm M — QUẢN TRỊ

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADM-01 | Người dùng | `/quantri/nguoidung` | QT | `FgTable` (tên, email, vai trò, công ty, trạng thái + nhãn link mời, đăng nhập cuối) + tạo tài khoản mới (email/công ty/vai trò/bộ phận/hạn mức) → nhận **link kích hoạt có chữ ký, hạn 1 ngày** để copy gửi tay; xem lại/copy lại link, **regenerate** (vô hiệu link cũ tức thì), **thu hồi link**; tài khoản **đã kích hoạt vẫn cấp được link đổi mật khẩu** (cùng cơ chế ký) — dùng xong link chết, thu hồi mọi phiên cũ; khóa/reset | bị khóa, chưa kích hoạt, link hết hạn/thu hồi | P2 | D |
| ADM-02 | Tạo / sửa người dùng | `/quantri/nguoidung/moi` | QT | form + `FgRolePicker` + `FgCompanyPicker` (phân quyền theo công ty) | email trùng, thiếu vai trò | P2 | D |
| ADM-03 | Vai trò & phân quyền (RBAC) | `/quantri/vai-tro` | QT | ma trận vai trò × quyền (§III), `FgSwitch` per quyền, ghi chú "không cho tự duyệt hồ sơ mình tạo" | quyền xung đột, vai trò đang dùng không xóa được | P2 | D |
| ADM-04 | **Approval Matrix** | `/quantri/quy-trinh-duyet` | QT, TGĐ, CT | bảng ngưỡng tiền → chuỗi cấp (§XX), **cấu hình được, không hard-code**, editor theo dải + preview `FgApprovalTimeline` cho từng khoảng | preview chưa lưu, thay đổi có audit, va chạm ngưỡng | **P2** | D |
| ADM-05 | Quy trình & SLA | `/quantri/quy-trinh` | QT, KTT | cấu hình bước, SLA chờ từng cấp, bắt buộc ý kiến, cấp điều kiện (skipped + lý do) | SLA vi phạm nhiều (warning) | P3 | D |
| ADM-06 | Công ty | `/quantri/cong-ty` | QT | `FgTable` + form (mã, tên, MST, người đại diện, trạng thái) + ngưỡng `minBalance` | công ty dừng hoạt động, còn dữ liệu mở | P2 | D |
| ADM-07 | Bộ phận / đơn vị | `/quantri/bo-phan` | QT | cây cấu trúc + form | còn hồ sơ tham chiếu | P2 | D |
| ADM-08 | Danh mục khoản chi / thu | `/quantri/danh-muc` | KTT, QT | §VI (4 nhóm + danh mục tùy chỉnh), `FgTree` + form, gộp/ẩn danh mục | đang dùng cho hồ sơ → chỉ ẩn, không xóa | P2 | D |
| ADM-09 | Nguồn tiền & tài khoản đối ứng | `/quantri/nguon-tien` | KTT | `FgTable` loại nguồn (TK NH, tiền mặt, vay, nội bộ) | | P3 | D |
| ADM-10 | Ngưỡng & cảnh báo | `/quantri/canh-bao` | QT, KTT | danh mục 8 cảnh báo §XVIII, bật/tắt + ngưỡng + kênh + người nhận per vai trò | kênh lỗi (test fail) | P3 | D |
| ADM-11 | Kênh thông báo & tích hợp ngoài | `/quantri/tich-hop` | QT | §XXIV/XXV: email, Telegram, Zalo OA, push; webhook; API token (tạo/thu hồi, scope quyền) | test gửi lỗi, token sắp hết hạn | P4 | D |
| ADM-12 | Audit log toàn hệ thống | `/quantri/audit` | QT, TGĐ, BKS | `FgTable` (ai · hành động · đối tượng · trước/sau · IP/device · thời gian), filter, **không có nút xóa**, diff viewer | kết quả > 10k dòng → bắt buộc hẹp filter, export có watermark | **P2** | D |
| ADM-13 | Log đăng nhập & phiên | `/quantri/dang-nhap` | QT | `FgTable` theo người/IP/thiết bị, thu hồi phiên từ xa | phiên bất thường → danger | P3 | D |
| ADM-14 | Sao lưu & phục hồi (DR) | `/quantri/du-phong` | QT | lịch backup, restore point, kiểm tra định kỳ | backup fail, đang restore (banner toàn app) | P4 | D |
| PREF-01 | Cài đặt cá nhân | `/ca-nhan` | tất cả | đổi mật khẩu, bật/tắt 2FA, theme, density, scope mặc định, phím tắt (§10 `Alt+D`), auto-mở hồ sơ kế tiếp, kênh nhận thông báo | 2FA chưa xác minh, theme/density theo phiên | P2 | D/M |
| IMP-01 | Nhập khẩu dữ liệu hàng loạt | `/quantri/nhap-lieu` | KT, QT | `FgUpload` + mapping cột + validate preview + xác nhận từng lô; import danh mục TK, công nợ, số dư đầu kỳ | file lỗi dòng (báo lỗi theo số dòng), lô dở dang, hoàn tác lô | P4 | D |

---

## 16. Nhóm N — Thông báo & cảnh báo

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NOTI-01 | Trung tâm thông báo | `/thong-bao` | tất cả | `FgMenu`/panel + trang đầy đủ: group theo loại, `FgStatusChip`, đánh dấu đã đọc, **deep-link** `?open=` tới DOC-01 | chưa đọc nhiều, thông báo hết hiệu lực (hồ sơ đã bị duyệt) | P2 | D/M |
| NOTI-02 | Đăng ký nhận cảnh báo | `/ca-nhan/canh-bao` | mọi vai trò | checkbox loại cảnh báo × kênh × khoảng thời gian | không chọn kênh nào (warning) | P3 | D/M |
| NOTI-03 | Cấu hình push / mobile | `/ca-nhan/push` | GĐ, PGĐ | token thiết bị, PIN/biometric (nếu có app), giờ im lặng | token fail | P4 | M |

Cảnh báo dạng toast (§7.18) không phải màn hình → §20.

---

## 17. Nhóm O — Tìm kiếm

| ID | Màn hình | Route | Vai trò | Component | St | Ph | Nền |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SRCH-01 | Lệnh tìm kiếm toàn cục | (overlay `⌘K`) | tất cả | `FgCommandPalette`: mã hồ sơ, nội dung, đối tượng, người lập, điều hướng màn hình | không có kết quả, không có quyền với kết quả | P3 | D |
| SRCH-02 | Kết quả tìm kiếm | `/tim-kiem?q=` | tất cả | `FgTabs` theo loại (chi/thu/vay/đảo hạn/đối tượng) + `FgTable` | 0 kết quả vs 0 kết quả vì quyền (khác CTA, §7.20) | P3 | D/M |

Tìm kiếm trong `FgFilterBar` (§7.11) debounce 300ms đã nằm ở từng danh sách — không phải màn riêng.

---

## 18. Nhóm P — Lỗi & trạng thái hệ thống

| ID | Màn hình | Route | Component | Khi nào | Ph |
| --- | --- | --- | --- | --- | --- |
| ERR-01 | 403 Không có quyền | `/403` | `FgEmptyState` (giải thích quyền, **không CTA** §7.20) | truy cập hồ sơ ngoài scope | P1 |
| ERR-02 | 404 Không tìm thấy | `/404` | `FgEmptyState` + [Về dashboard] | link sai/hồ sơ bị xóa mềm | P1 |
| ERR-03 | 409 Xung đột phiên bản | overlay | `FgAlert` "Hồ sơ đã được Nguyễn B duyệt lúc 09:15. Tải lại." | hai người cùng duyệt | P2 |
| ERR-04 | 500 / Sự cố hệ thống | `/500` | `FgErrorState` + retry + mã lỗi để báo helpdesk | server error | P1 |
| ERR-05 | Bảo trì / tạm ngưng | `/bao-tri` | full-page, thời gian dự kiến, bản tin cuối cùng còn đọc được | deploy/DR | P4 |
| ERR-06 | Mất kết nối / dữ liệu chưa đồng bộ | banner + `FgAlert partial` | "Dữ liệu Công ty B chưa đồng bộ · cập nhật 07:10" | API chậm/partial | P2 |

---

## 19. Nhóm Q — Mobile (approval-first, §1.6 + §XXIV)

Mobile **không phải desktop thu nhỏ**: không filter bar đa cột, không bảng >3 cột (§5.4).

| ID | Màn hình | Route/entry | Component | St | Ph |
| --- | --- | --- | --- | --- | --- |
| MOB-01 | Bảng điều hành Giám đốc (bottom tab 4 mục) | `/m` | Tiền hiện có → Cần duyệt → Cảnh báo → Đáo hạn → Dòng tiền (§5.4) | stale, offline | P4 |
| MOB-02 | Hàng chờ của tôi | `/cho-toi-duyet` (responsive APPR-01) | card list 4 field: nội dung · số tiền · chờ N ngày · chip | 0 hồ sơ | P4 |
| MOB-03 | Hồ sơ để duyệt | `/ho-so/:type/:id` (DOC-01 bản mobile) | **1 luồng cuộn, không tab**: header → 6 câu hỏi → chứng từ (mở rộng) → timeline → `FgActionBar` đáy (`z-approval-bar`) | thiếu chứng từ, 409 | **P4** |
| MOB-04 | Xác nhận duyệt (bottom-sheet) | overlay | số tiền + người nhận + nguồn tiền + dư sau chi; `FgMoneyInput`-style gõ lại số tiền nếu >5 tỷ/ngoài ngân sách; sinh hiệu/PIN nếu bật 2FA | fail sinh hiệu, timeout | P4 |
| MOB-05 | Xem chứng từ toàn màn hình | overlay | lightbox PDF/ảnh, pinch-zoom, tải (chỉ khi có quyền) | file lỗi, đang tải | P4 |
| MOB-06 | Notification mở vào hồ sơ | deep link `?open=` | 1 chạm: notification → MOB-03 → duyệt | thông báo lỗi thời | P4 |

Yêu cầu: touch target ≥44, action bar sticky `--fg-shadow-4`, mọi CTA có số tiền trong nhãn, duyệt được ≤3 thao tác (§8.2).

---

## 20. Nhóm R — Overlay (KHÔNG phải route — liệt kê để khỏi làm thành trang)

| ID | Overlay | gọi từ | Component |
| --- | --- | --- | --- |
| OVL-01 | Hồ sơ chi tiết dạng drawer 6/12 | mọi `FgTable` | `FgDrawer` (giữ ngữ cảnh lọc) |
| OVL-02 | `FgApprovalConfirm` — 6 câu hỏi kiểm soát | APPR-01, CHI-0x, DOC-01, MOB-03 | `FgModal` |
| OVL-03 | Duyệt hàng loạt (review từng hồ sơ + tổng tiền) | bulk bar | `FgModal` + stepper |
| OVL-04 | Từ chối — `FgReasonPicker` + ý kiến bắt buộc | action bar | `FgModal` |
| OVL-05 | Yêu cầu bổ sung — chọn nội dung cần bổ sung | action bar | `FgModal` |
| OVL-06 | Upload chứng từ | CHI-02, DOC-01 tab Chứng từ | `FgDrawer` + `FgUpload` |
| OVL-07 | Preview PDF inline | `FgDocList` | `FgDrawer` |
| OVL-08 | Ánh hưởng số dư khi bấm vào số tiền | `FgMoney`, KPI | `FgPopover` |
| OVL-09 | Column chooser / density / lưu view | `FgTable` | `FgPopover` |
| OVL-10 | Đổi scope công ty | header | `FgMenu` (`FgScopeSwitcher`) |
| OVL-11 | Nhắc tạo khoản định kỳ sắp tới | DASH, CHI-08 | `FgModal` (dismiss được, không phải risk 3) |
| OVL-12 | Bỏ bản chỉnh sửa (dirty form) | form | `FgConfirmDialog` |
| OVL-13 | Gõ lại số tiền (khoản >5 tỷ / ngoài ngân sách) | action bar | `FgModal` |
| OVL-14 | Chữ ký số / OTP cho bước thanh toán | CHI-06 | `FgModal` |
| OVL-15 | Sao chép liên kết hồ sơ | row menu `⋯` | `FgToast` |
| OVL-16 | Nhân bản hồ sơ | row menu | `FgConfirmDialog` |
| OVL-17 | Chọn template ý kiến duyệt | DOC-01 | `FgPopover` |
| OVL-18 | Bảng dữ liệu thay thế chart ("Xem dạng bảng") | mọi chart | `FgModal` |
| OVL-19 | Tour lần đầu / giải thích Approval Matrix | DASH-01, ADM-04 | `FgTooltip` + overlay |
| OVL-20 | Print stylesheet preview | RPT-xx, DASH-03 | chế độ in |
| OVL-21 | Toast notification (thành công/lỗi/undo) | mọi mutation | `FgToast` |

---

## 21. Màn hình dùng chung khung (không tính là design mới)

3 bộ khung phải dựng một lần, dùng lại cho ~38 route:

| Khung | Áp dụng cho | Cấu tạo |
| --- | --- | --- |
| **List + FilterBar + Table** | CHI-01/04/05/07, THU-01/03/04, BANK-01/04/05/07, LOAN-01/04, DEBT-01/03/05, RENEW-01, APPR-01/02/03, ADM-01/06/07/08, NOTI-01 | page header + `FgFilterBar` sticky + `FgTable` + `FgPagination` + 4 trạng thái (loading/empty/error/partial) |
| **Hồ sơ form (create/edit)** | CHI-02/03/09, THU-02/05, BANK-02/08, LOAN-03, RENEW-02/04, DEBT-06, ADM-02 | section grid + `FgField` + autosave draft + validate + `FgDocList` + action bar Lưu/Gửi |
| **Report runner** | RPT-00…14 | filter kỳ + scope → KPI → chart → bảng → export |

---

## 22. Thứ tự thi công (khớp roadmap §13.5)

| Phase | Màn hình | Lý do thứ tự |
| --- | --- | --- |
| **P0** | `DASH-01` (skeleton 5 tầng) + ERR-01/02/04 + app shell (`FgAppShell`, rail, header) | dựng trên `tokens.css` + `status/registry` + `format` + `FgButton/Text/Field/Input/Table/StatusChip`; chứng minh token đủ dùng trước khi nhân ra 100 màn |
| **P1** | AUTH-01/03/04, DASH-01 bản đầy đủ, APPR-01, CHI-01/04, THU-01, BANK-01, khung List (mọi màn danh sách chỉ chờ dữ liệu) | App shell + FilterBar + Drawer + Modal + Pagination + Tabs + Empty/Skeleton + Toast |
| **P2** | DOC-01, CHI-02/03/05/06/07, THU-02/03/04/05, BANK-02/03/04, LOAN-01/02, RENEW-01/02/03, DEBT-01/03, DASH-02/05, ADM-01/02/03/04/06/07/08, ADM-12, NOTI-01, PREF-01, AUTH-05/06, ERR-03/06 | toàn bộ Finance components (`FgMoney` `FgKpiCard` `FgApprovalTimeline` `FgApprovalActionBar` `FgDocList` `FgMaturityTable` `FgBankAccountCard` `FgLoanCard`) |
| **P3** | CASH-01/02/06, RENEW-04/05, LOAN-03/04, DEBT-02/04/05, BANK-05/06/07/08, CHI-08/09, THU-06, RPT-00→13, DASH-03/04, ADM-05/09/10/13, NOTI-02, SRCH-01/02, APPR-04 | Charts + Forecast + ExceptionList + Report + **bản tin hàng ngày** (giá trị cao nhất cho Giám đốc, nhưng phụ thuộc forecast) |
| **P4** | MOB-01→06, CASH-03/04/05, DEBT-06, BANK-09, RPT-13, ADM-11/14, IMP-01, DASH-01 `view=ops`, AUTH-02, ERR-05 | dark production, mobile approval, 2FA confirm, print/Excel stylesheet, tích hợp ngoài |

Ghi chú thứ tự: **không** làm báo cáo trước khi forecast xong (RPT-08 dùng cùng `FgCashFlowTable`), **không** làm mobile trước khi DOC-01 desktop ổn định (mobile là cùng một data contract, khác layout).

---

## 23. Definition of Done cho mọi màn hình (trích §13.4 + ràng buộc riêng của danh mục này)

- [ ] Có ID màn hình này trong ticket, khớp tên route file trong `apps/web/src/screens/**` (§12.5).
- [ ] Page header đúng §5.3: tên nghiệp vụ là `h1`, mã hồ sơ là `text-link`, scope + thời điểm luôn hiển thị.
- [ ] Action chính nằm trong viewport đầu ở 1440×900 (§1.1).
- [ ] Đủ 8 trạng thái: `default · loading(skeleton) · empty · no-results · error · partial · 403 · stale` (§7.10/§7.20).
- [ ] Mọi status qua `status/registry`; mọi `pending.*` hiện **đang ở bàn ai** + **đã chờ N ngày** (§1.5, §7.13).
- [ ] Mọi số qua `@fingate/ui/format`; compact ở header + full ở chi tiết; `tabular-nums`, cột số thẳng hàng (§1.3).
- [ ] Chỉ semantic token, lint `no-raw-color` pass; light + dark; grayscale test (§3.4).
- [ ] Keyboard-only path cho toàn luồng duyệt (`Tab/Enter/Shift+Tab/Ctrl+Enter/Alt+D/Alt+X`) (§10).
- [ ] Responsive đủ 6 breakpoint; mobile theo §5.4, không phải desktop thu nhỏ.
- [ ] Deep-link tới từ notification mở đúng hồ sơ + giữ bộ lọc nguồn.
- [ ] Không có "Lorem"; dữ liệu demo đúng nghiệp vụ (2,50 tỷ · VCB · đảo hạn · Công ty A→B).
- [ ] Quyền: cột/nút/export **ẩn** khi không có quyền, kèm giải thích vì sao ẩn (§XXVI).

---

## 24. Câu hỏi mở (chốt trước khi vào P2)

| # | Câu hỏi | Đề xuất |
| --- | --- | --- |
| Q-01 | Logo/màu thương hiệu ngân hàng trong `FgBankAccountCard`? | Không dùng màu brand NH; neutral + `FgIcon` chung (đề xuất của DS §Phụ lục C) |
| Q-02 | Ai được đổi `minBalance` per công ty/TK, có vào audit? | Kế toán trưởng; có audit (ảnh hưởng mọi cảnh báo dòng tiền) |
| Q-03 | Có **màn hình tạo đề nghị chi cho Giám đốc** (GĐ khởi tạo, không chỉ duyệt)? | Blueprint chỉ mô tả GĐ là cấp duyệt → tạm **không** làm; cần xác nhận |
| Q-04 | Chứng từ bắt buộc theo loại khoản chi — ai định nghĩa, screen nào? | Đề xuất thêm cấu hình trong ADM-08 (rule per danh mục), validate ở CHI-02 + DOC-01 |
| Q-05 | Ủy quyền phê duyệt (APPR-04) có nằm trong phạm vi kỳ 1? | Nên có ở P3 — nếu không, hàng chờ đứng khi GĐ đi công tác |
| Q-06 | Ngân sách (`CASH-04`) lấy từ đâu: nhập trong FinGate hay đồng bộ ERP? | Kỳ 1 nhập tay + import; P4 mới tích hợp |
| Q-07 | Có màn hình "quỹ tiền mặt" (cash on hand) riêng không, hay chỉ là loại TK trong BANK-01? | Tạm gộp vào BANK-01/04; tách nếu công ty có nhiều quỹ |
| Q-08 | Chat/trao đổi 2 chiều trong hồ sơ (ngoài ý kiến phê duyệt) có cần? | Chỉ `FgOpinion` + loại ý kiến (§7.15); không làm chat kỳ 1 |
| Q-09 | Bảng điều hành riêng cho Chủ tịch/HĐQT (cấp sau GĐ trong timeline §7.13)? | Timeline đã chừa sẵn node `waiting`; chưa có màn riêng |
| Q-10 | Kênh mobile push: web push hay bắt buộc có app native? | P4: web push + PWA; native out-of-scope kỳ 1 |

---

## 25. Đối chiếu nhanh với blueprint (đảm bảo không sót yêu cầu)

| Yêu cầu blueprint | Màn hình đáp ứng |
| --- | --- |
| I.10 mục tiêu | B, E, F, G, H, I, J, K, L, M |
| III.5 vai trò | mọi màn + ADM-01/03, PREF-01, DASH-02 |
| IV quy trình + trạng thái | APPR-01→03, DOC-01, `status/registry` |
| V phiếu đề nghị chi + chứng từ | CHI-02/03 + OVL-06/07 |
| VI phân loại khoản chi | ADM-08, RPT-10 |
| VII khoản thu + 4 góc nhìn | THU-01→06 |
| VIII ngân hàng + số dư 6 chỉ tiêu | BANK-01→06 |
| IX vay ngân hàng | LOAN-01→04 |
| X "màn hình riêng" đảo hạn + 4 mức cảnh báo | **RENEW-01** |
| XI quy trình đảo hạn | RENEW-02→04 |
| XII Dashboard Giám đốc | DASH-01 |
| XIII "Giám đốc cần duyệt" | APPR-01 + DASH-01 tầng 02 |
| XIV bản tin hàng ngày | DASH-03/04 |
| XV dự báo dòng tiền + ngưỡng | CASH-01/06 |
| XVI công nợ phải thu/trả | DEBT-01→05 |
| XVII chi định kỳ + nhắc 7/3/1 | CHI-08/09 |
| XVIII 8 loại cảnh báo | ADM-10, NOTI-01/02, CASH-06 |
| XIX audit log, không được xóa | DOC-01 tab Audit, ADM-12 |
| XX Approval Matrix cấu hình được | ADM-04 |
| XXI đa công ty + chuyển tiền nội bộ | `FgScopeSwitcher` mọi màn, BANK-07/08 |
| XXII 13 báo cáo | RPT-01→13 |
| XXIII menu | §2 sitemap |
| XXIV duyệt trên điện thoại + OTP/biometric | MOB-01→06, AUTH-02 |
| XXV API-first | ADM-11, IMP-01, BANK-09 |
| XXVI bảo mật (RBAC, 2FA, timeout, log, không tải sai quyền) | ADM-01/03/11/12/13, AUTH-02/06, PREF-01, RPT-14 |
| XXVII 6+1 câu hỏi trước khi duyệt | DOC-01 tab `Tóm tắt`, OVL-02, OVL-13 |
| XXVIII dashboard ASCII | DASH-01 tầng 01–05 |
