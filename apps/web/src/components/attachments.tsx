/**
 * FgUpload / FgDocList (DS §7.9) — tải chứng từ ảnh/PDF, xem trước trực tiếp, xoá khi
 * chưa bị cấp duyệt tham chiếu. Luồng: prepare (presigned PUT) → PUT byte → confirm.
 */

import { useRef, useState, type ReactNode } from 'react';
import { message } from 'antd';
import { EVIDENCE_LABEL, EVIDENCE_TYPES, type EvidenceType } from '@fingate/shared';
import type { AttachmentRef, DocumentDetail } from '../app/types.ts';
import { ApiRequestError, apiData } from '../app/api.ts';
import { FgAlert, FgButton, FgField, FgSelect, FgText, FgTooltip } from './primitives.tsx';
import { FgEmptyState, FgModal, FgProgressBar } from './uitk.tsx';

const IMAGE_MIME = /^image\//;
const MAX_BYTES = 25 * 1024 * 1024;

export function isImage(att: AttachmentRef): boolean {
  return IMAGE_MIME.test(att.mime) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.filename);
}

export function isPdf(att: AttachmentRef): boolean {
  return att.mime === 'application/pdf' || /\.pdf$/i.test(att.filename);
}

export function attachmentHref(att: AttachmentRef, download = false): string {
  return `/api/v1/attachments/${att.id}${download ? '?download=1' : ''}`;
}

function acceptForUpload(file: File): boolean {
  if (file.type === 'application/pdf' || IMAGE_MIME.test(file.type)) return true;
  // một số trình duyệt không gắn MIME → dò theo đuôi
  return !file.type && /\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(file.name);
}

function mimeOf(file: File): string {
  if (file.type) return file.type;
  return /\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream';
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function sha256HexFromBytes(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = len * 8;
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return [...h].map((v) => v.toString(16).padStart(8, '0')).join('');
}

async function sha256OfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256HexFromBytes(new Uint8Array(buf));
}

function putFile(url: string, file: File, headers: Record<string, string>, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('Không kết nối được nơi lưu tệp'));
    xhr.send(file);
  });
}

function problemText(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) return e.problem.detail ?? e.problem.title ?? fallback;
  return e instanceof Error ? e.message : fallback;
}

const TYPE_OPTIONS = EVIDENCE_TYPES.map((t) => ({ value: t, label: EVIDENCE_LABEL[t] }));

export function AttachmentUploadModal({ doc, onClose, onDone }: { doc: DocumentDetail; onClose: () => void; onDone: () => void }): ReactNode {
  const firstMissing = (doc.evidence.missing[0] ?? 'other') as EvidenceType;
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<string>(EVIDENCE_TYPES.includes(firstMissing) ? firstMissing : 'other');
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | null): void => {
    setError(null);
    if (!f) return setFile(null);
    if (!acceptForUpload(f)) return setError('Chỉ nhận ảnh (PNG/JPG/GIF/WebP) hoặc PDF');
    if (f.size > MAX_BYTES) return setError('Tệp vượt 25 MB');
    setFile(f);
  };

  const submit = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setPercent(0);
    try {
      const sha256 = await sha256OfFile(file);
      const prep = await apiData<{ upload_url: string; attachment_id: string; required_headers: Record<string, string> }>(
        `/documents/${doc._id}/attachments/prepare`,
        { method: 'POST', body: { filename: file.name, size: file.size, mime: mimeOf(file), sha256, type, if_match: doc.version } },
      );
      await putFile(prep.upload_url, file, prep.required_headers ?? {}, setPercent);
      await apiData(`/documents/${doc._id}/attachments/confirm`, {
        method: 'POST',
        body: { attachment_id: prep.attachment_id, if_match: doc.version },
      });
      message.success('Đã tải chứng từ lên');
      onDone();
    } catch (e) {
      setError(problemText(e, 'Không tải được chứng từ'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgModal
      open
      title="Tải chứng từ lên"
      onCancel={onClose}
      width={520}
      footer={
        <>
          <FgButton onClick={onClose} disabled={busy}>
            Hủy
          </FgButton>
          <FgButton variant="primary" loading={busy} disabled={!file} onClick={() => void submit()}>
            Tải lên
          </FgButton>
        </>
      }
    >
      <FgField label="Loại chứng từ">
        <FgSelect options={TYPE_OPTIONS} value={type} onChange={(v) => setType(v ?? 'other')} style={{ width: '100%' }} />
      </FgField>
      <div style={{ marginTop: 12 }}>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            pick(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pick(e.dataTransfer.files?.[0] ?? null);
          }}
          style={{
            width: '100%',
            padding: 'var(--fg-space-6) var(--fg-space-4)',
            border: '1px dashed var(--fg-border-default)',
            borderRadius: 'var(--fg-radius-md)',
            background: 'var(--fg-bg-subtle)',
            cursor: busy ? 'default' : 'pointer',
            textAlign: 'center',
          }}
        >
          <FgText style="body" color="secondary">
            {file ? file.name : 'Bấm để chọn hoặc kéo thả tệp vào đây'}
          </FgText>
          <div>
            <FgText style="caption" color="muted">
              Ảnh hoặc PDF · tối đa 25 MB
            </FgText>
          </div>
        </button>
      </div>
      {busy ? (
        <div style={{ marginTop: 12 }}>
          <FgProgressBar percent={percent} label={percent > 0 ? `Đang tải lên ${Math.round(percent)}%` : 'Đang xử lý…'} />
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 12 }}>
          <FgAlert tone="danger" title={error} />
        </div>
      ) : null}
    </FgModal>
  );
}

export function AttachmentPreviewModal({ att, onClose }: { att: AttachmentRef; onClose: () => void }): ReactNode {
  const href = attachmentHref(att);
  return (
    <FgModal
      open
      title={att.filename}
      width={880}
      onCancel={onClose}
      footer={
        <FgButton onClick={() => window.open(attachmentHref(att, true), '_blank')}>⤓ Tải về</FgButton>
      }
    >
      <div style={{ minHeight: 240, display: 'grid', placeItems: 'center' }}>
        {isImage(att) ? (
          <img src={href} alt={att.filename} style={{ maxWidth: '100%', maxHeight: '72vh', objectFit: 'contain', borderRadius: 'var(--fg-radius-sm)' }} />
        ) : isPdf(att) ? (
          <iframe src={href} title={att.filename} style={{ width: '100%', height: '72vh', border: 'none', borderRadius: 'var(--fg-radius-sm)' }} />
        ) : (
          <FgEmptyState glyph="◇" title="Không xem trước được" description="Định dạng này chỉ tải về để mở bằng ứng dụng phù hợp." />
        )}
      </div>
    </FgModal>
  );
}

export function AttachmentDeleteModal({
  doc,
  att,
  onClose,
  onDone,
}: {
  doc: DocumentDetail;
  att: AttachmentRef;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiData(`/documents/${doc._id}/attachments/${att.id}/remove`, { method: 'POST', body: { if_match: doc.version } });
      message.success('Đã xoá chứng từ');
      onDone();
    } catch (e) {
      setError(problemText(e, 'Không xoá được chứng từ'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgModal
      open
      title="Xoá chứng từ"
      onCancel={onClose}
      width={480}
      footer={
        <>
          <FgButton onClick={onClose} disabled={busy}>
            Hủy
          </FgButton>
          <FgButton variant="danger" loading={busy} onClick={() => void submit()}>
            Xoá
          </FgButton>
        </>
      }
    >
      <FgText style="body">
        Xoá <strong>{att.filename}</strong> khỏi hồ sơ? Tệp chỉ xoá được khi chưa cấp duyệt nào tham chiếu.
      </FgText>
      {error ? (
        <div style={{ marginTop: 12 }}>
          <FgAlert tone="danger" title={error} />
        </div>
      ) : null}
    </FgModal>
  );
}

export function AttachmentRow({
  att,
  canAttach,
  onPreview,
  onRemove,
}: {
  att: AttachmentRef;
  canAttach: boolean;
  onPreview: () => void;
  onRemove: () => void;
}): ReactNode {
  return (
    <div
      role="listitem"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--fg-space-3)',
        padding: 'var(--fg-space-2) 0',
        borderBottom: 'var(--fg-border-w-1) solid var(--fg-border-subtle)',
      }}
    >
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Xem ${att.filename}`}
        style={{
          width: 48,
          height: 48,
          flex: '0 0 auto',
          padding: 0,
          border: 'var(--fg-border-w-1) solid var(--fg-border-default)',
          borderRadius: 'var(--fg-radius-sm)',
          background: 'var(--fg-bg-subtle)',
          cursor: 'pointer',
          overflow: 'hidden',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {isImage(att) ? (
          <img src={attachmentHref(att)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <FgText style="caption" strong color="secondary">
            {isPdf(att) ? 'PDF' : 'TỆP'}
          </FgText>
        )}
      </button>
      <div style={{ minWidth: 0, flex: 1 }}>
        <button
          type="button"
          onClick={onPreview}
          className="fg-link"
          style={{ all: 'unset', cursor: 'pointer', color: 'var(--fg-text-link)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {att.filename}
        </button>
        <FgText style="caption" color="muted">
          {EVIDENCE_LABEL[att.type as EvidenceType] ?? att.type} · {Math.max(1, Math.round(att.size / 1024))} KB · v{att.version}
          {att.referenced ? ' · đã tham chiếu' : ''}
        </FgText>
      </div>
      <FgTooltip title="Xem trực tiếp">
        <FgButton size="small" onClick={onPreview}>
          Xem
        </FgButton>
      </FgTooltip>
      <FgTooltip title="Tải về (đánh dấu đã tham chiếu — không xoá được nữa)">
        <FgButton size="small" onClick={() => window.open(attachmentHref(att, true), '_blank')}>
          ⤓
        </FgButton>
      </FgTooltip>
      <FgTooltip title={att.referenced ? 'Đã bị cấp duyệt tham chiếu — không xoá được' : canAttach ? 'Xoá chứng từ' : 'Bạn không có quyền xoá'}>
        <FgButton size="small" variant="danger" disabled={!canAttach || att.referenced} onClick={onRemove}>
          Xoá
        </FgButton>
      </FgTooltip>
    </div>
  );
}
