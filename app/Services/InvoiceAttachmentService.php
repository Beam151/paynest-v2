<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\SignedUrl;
use Config\Paynest;

/**
 * รูป/PDF ประกอบบิล — ส่วนกลางแนบ ร้านเจ้าของบิลเห็นผ่าน GET /api/invoices/:id (ลิงก์ที่เซ็นแล้ว)
 *
 * ไฟล์อัปโหลดผ่าน POST /api/uploads ก่อนเหมือนสลิป แล้วค่อยเอา url มาผูกกับบิลที่นี่
 * ลบ = ซ่อนจากบิล (removed_at) ไฟล์จริงไม่ถูกลบ — เป็นหลักฐาน และไฟล์สำรองก็ mirror ไปแล้ว
 * แนบเพิ่มได้แม้ร้านจ่ายแล้ว (หลักฐานบางอย่างมาทีหลัง) — รูปไม่เปลี่ยนตัวเลขเงินในบิล
 */
final class InvoiceAttachmentService
{
    /** แบบเดียวกับสลิป/QR · D = ห้ามมีขึ้นบรรทัดใหม่ต่อท้าย ($ เฉย ๆ ยอม "\n" ท้ายสตริง) */
    public const UPLOAD_RE = '/^\/api\/uploads\/[0-9a-f]{32}\.(jpg|png|gif|webp|pdf)$/D';

    public const MAX_PER_INVOICE = 10;

    /**
     * ตรวจไฟล์ก่อนผูกกับบิล — ใช้ทั้งตอนออกบิล (ยังไม่มี id บิล) และแนบเพิ่มทีหลัง
     *
     * ไฟล์ที่อัปโหลดไม่มีเจ้าของ (ชื่อสุ่ม) จึงต้องกันไม่ให้หยิบไฟล์ที่ผูกกับเรื่องอื่นอยู่แล้วมาแนบ
     * ไม่งั้นแค่รู้ชื่อไฟล์สลิปของร้าน ข ก็เอาไปโชว์ในบิลของร้าน ก ได้
     *
     * @param list<array{url: string, caption?: ?string}> $files
     *
     * @return list<array{url: string, caption: ?string}>
     */
    public static function prepare(?int $invoiceId, array $files): array
    {
        $active = $invoiceId === null ? 0 : self::activeCount($invoiceId);
        if ($active + count($files) > self::MAX_PER_INVOICE) {
            throw ApiException::badRequest('แนบได้สูงสุด ' . self::MAX_PER_INVOICE . ' รูปต่อบิล — ลบรูปเก่าก่อน');
        }
        $out  = [];
        $seen = [];
        foreach ($files as $f) {
            $url = is_string($f['url'] ?? null) ? $f['url'] : '';
            if (! preg_match(self::UPLOAD_RE, $url)) {
                throw ApiException::badRequest('ต้องแนบไฟล์ที่อัปโหลดผ่านระบบ (ไม่รับลิงก์ภายนอก)');
            }
            // สลิป/QR ตรวจแค่รูปแบบ แต่รูปประกอบบิลร้านจะเปิดดู — ชื่อที่ไม่มีไฟล์จริงคือรูปเสียบนหน้าบิล
            if (! is_file(config(Paynest::class)->uploadPath(basename($url)))) {
                throw ApiException::badRequest('ไม่พบไฟล์ที่อัปโหลด — อัปโหลดใหม่อีกครั้ง');
            }
            if (isset($seen[$url]) || self::usedElsewhere($url)) {
                throw ApiException::badRequest('ไฟล์นี้ถูกใช้กับรายการอื่นแล้ว — อัปโหลดใหม่');
            }
            $seen[$url] = true;
            $caption    = trim((string) ($f['caption'] ?? ''));
            $out[]      = ['url' => $url, 'caption' => $caption === '' ? null : $caption];
        }

        return $out;
    }

    /** เรียกภายใน transaction ของผู้เรียก — ต้องผ่าน prepare() มาก่อน */
    public static function insert(int $invoiceId, array $prepared, int $actorUserId): void
    {
        foreach ($prepared as $f) {
            Db::insert(
                'INSERT INTO invoice_attachments (invoice_id, file_url, caption, uploaded_by_user_id, created_at)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
                [$invoiceId, $f['url'], $f['caption'], $actorUserId],
            );
        }
    }

    /** แนบรูปเพิ่มให้บิลที่ออกไปแล้ว */
    public static function add(int $invoiceId, array $files, array $user): array
    {
        $inv = Db::one('SELECT * FROM invoices WHERE id = ?', [$invoiceId]) ?? throw ApiException::notFound('ไม่พบใบเรียกเก็บ');
        if ($inv['status'] === 'VOID') {
            throw ApiException::conflict('บิลที่ยกเลิกแล้วแนบรูปไม่ได้');
        }

        return Db::tx(static function () use ($invoiceId, $files, $user) {
            // ล็อกบิลก่อนนับ — แนบพร้อมกันสองหน้าต่างต้องไม่ทะลุเพดาน 10 รูป
            Db::one('SELECT id FROM invoices WHERE id = ? FOR UPDATE', [$invoiceId]);
            $prepared = self::prepare($invoiceId, $files);
            self::insert($invoiceId, $prepared, (int) $user['id']);
            Audit::write((int) $user['id'], 'invoice.attachment.add', 'invoice', $invoiceId, [
                'count' => count($prepared),
                'urls'  => array_column($prepared, 'url'),
            ]);

            return InvoiceService::get($invoiceId, $user);
        });
    }

    /** ซ่อนรูปออกจากบิล — ไฟล์จริงเก็บไว้ (หลักฐาน · ไฟล์สำรองก็มีอยู่แล้ว) */
    public static function remove(int $invoiceId, int $attachmentId, array $user): array
    {
        $inv = Db::one('SELECT * FROM invoices WHERE id = ?', [$invoiceId]) ?? throw ApiException::notFound('ไม่พบใบเรียกเก็บ');
        if ($inv['status'] === 'VOID') {
            throw ApiException::conflict('บิลที่ยกเลิกแล้วลบรูปประกอบไม่ได้');
        }
        $att = Db::one('SELECT * FROM invoice_attachments WHERE id = ? AND invoice_id = ? AND removed_at IS NULL', [$attachmentId, $invoiceId])
            ?? throw ApiException::notFound('ไม่พบรูปประกอบนี้ในบิล (อาจถูกลบไปแล้ว)');

        return Db::tx(static function () use ($invoiceId, $attachmentId, $att, $user) {
            Db::exec(
                'UPDATE invoice_attachments SET removed_at = UTC_TIMESTAMP(), removed_by_user_id = ? WHERE id = ? AND removed_at IS NULL',
                [$user['id'], $attachmentId],
            );
            Audit::write((int) $user['id'], 'invoice.attachment.remove', 'invoice', $invoiceId, [
                'attachmentId' => $attachmentId,
                'url'          => $att['file_url'],
                'caption'      => $att['caption'],
            ]);

            return InvoiceService::get($invoiceId, $user);
        });
    }

    /** รูปที่ยังแสดงอยู่ของบิล — ลิงก์เซ็นใหม่ทุกครั้ง (หมดอายุใน 1–2 ชม. เหมือนสลิป) */
    public static function listFor(int $invoiceId): array
    {
        return array_map(static fn ($r) => [
            'id'        => (int) $r['id'],
            'url'       => SignedUrl::sign($r['file_url']),
            'type'      => str_ends_with($r['file_url'], '.pdf') ? 'pdf' : 'image',
            'caption'   => $r['caption'],
            'createdAt' => $r['created_at'],
        ], Db::all('SELECT * FROM invoice_attachments WHERE invoice_id = ? AND removed_at IS NULL ORDER BY id', [$invoiceId]));
    }

    private static function activeCount(int $invoiceId): int
    {
        return Db::int('SELECT COUNT(*) FROM invoice_attachments WHERE invoice_id = ? AND removed_at IS NULL', [$invoiceId]);
    }

    /** ไฟล์นี้ผูกกับสลิป / QR บัญชี / รูปประกอบบิลใดก็ตาม (รวมที่ลบไปแล้ว) อยู่แล้วหรือยัง */
    private static function usedElsewhere(string $url): bool
    {
        return Db::int(
            'SELECT (SELECT COUNT(*) FROM payment_submissions WHERE slip_url = ?)
                  + (SELECT COUNT(*) FROM bank_accounts WHERE qr_url = ?)
                  + (SELECT COUNT(*) FROM invoice_attachments WHERE file_url = ?)',
            [$url, $url, $url],
        ) > 0;
    }
}
