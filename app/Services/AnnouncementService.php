<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Clock;
use App\Libraries\Db;

/**
 * กระดานประกาศจากส่วนกลางถึงทุกร้าน — โปรโมชั่น สินค้าใหม่ วันหยุด
 * ร้านเห็นเฉพาะประกาศที่อยู่ในช่วงเผยแพร่ · ส่วนกลางเห็นทั้งหมดรวมที่ตั้งเวลาไว้/หมดอายุแล้ว
 */
final class AnnouncementService
{
    public const CATEGORY_LABEL = ['NEWS' => 'ข่าวสาร', 'PROMO' => 'โปรโมชั่น', 'PRODUCT' => 'สินค้าใหม่', 'HOLIDAY' => 'วันหยุด'];

    private static function serialize(array $row): array
    {
        $today = Clock::todayThai();
        $state = $row['starts_at'] > $today ? 'SCHEDULED' : ($row['ends_at'] && $row['ends_at'] < $today ? 'EXPIRED' : 'ACTIVE');

        return [
            'id'            => (int) $row['id'],
            'title'         => $row['title'],
            'body'          => $row['body'],
            'category'      => $row['category'],
            'categoryLabel' => self::CATEGORY_LABEL[$row['category']] ?? null,
            'pinned'        => (int) $row['pinned'] === 1,
            'startsAt'      => $row['starts_at'],
            'endsAt'        => $row['ends_at'],
            'state'         => $state,
            'read'          => $row['read_at'] !== null,
            'createdAt'     => $row['created_at'],
            'author'        => $row['author'] ?? null,
        ];
    }

    public static function list(array $user): array
    {
        $today      = Clock::todayThai();
        $onlyActive = ! AuthContext::isSuperAdmin($user);
        $rows       = array_map([self::class, 'serialize'], Db::all(
            'SELECT a.*, r.read_at, u.display_name AS author
               FROM announcements a
               LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
               LEFT JOIN users u ON u.id = a.created_by
              ' . ($onlyActive ? 'WHERE a.starts_at <= ? AND (a.ends_at IS NULL OR a.ends_at >= ?)' : '') . '
              ORDER BY a.pinned DESC, a.starts_at DESC, a.id DESC',
            $onlyActive ? [$user['id'], $today, $today] : [$user['id']],
        ));
        if (! $onlyActive) {
            /*
             * ส่วนกลาง: อ่านแล้วกี่ร้าน — นับเป็นร้าน ไม่ใช่คน (ในร้านมีคนเปิดอ่านคนเดียวก็ถือว่าร้านรู้แล้ว)
             * นับเฉพาะร้านที่ยังเปิดอยู่ ร้านที่ปิดไปแล้วไม่ต้องไปตาม
             */
            $totalShops = Db::int("SELECT COUNT(*) FROM franchises WHERE status = 'ACTIVE'");
            $readCounts = array_column(Db::all(
                "SELECT r.announcement_id AS id, COUNT(DISTINCT u.franchise_id) AS n
                   FROM announcement_reads r
                   JOIN users u ON u.id = r.user_id AND u.role = 'FRANCHISE'
                   JOIN franchises f ON f.id = u.franchise_id AND f.status = 'ACTIVE'
                  GROUP BY r.announcement_id",
            ), 'n', 'id');
            foreach ($rows as &$row) {
                $row['reach'] = ['read' => (int) ($readCounts[$row['id']] ?? 0), 'total' => $totalShops];
            }
            unset($row);
        }

        return ['items' => $rows, 'unread' => count(array_filter($rows, static fn ($r) => $r['state'] === 'ACTIVE' && ! $r['read']))];
    }

    /** ร้านไหนอ่านแล้ว / ยังไม่อ่าน — ไว้ตามประกาศสำคัญ (เช่นวันหยุด) กับร้านที่ยังไม่เห็น */
    public static function readers(int $id, array $actor): array
    {
        self::get($id, $actor);
        $shops = Db::all(
            "SELECT f.id, f.username, f.contact_name, f.phone,
                    MIN(r.read_at) AS read_at,
                    (SELECT u2.display_name FROM announcement_reads r2 JOIN users u2 ON u2.id = r2.user_id
                      WHERE r2.announcement_id = ? AND u2.franchise_id = f.id ORDER BY r2.read_at LIMIT 1) AS first_reader
               FROM franchises f
               LEFT JOIN users u ON u.franchise_id = f.id AND u.role = 'FRANCHISE'
               LEFT JOIN announcement_reads r ON r.user_id = u.id AND r.announcement_id = ?
              WHERE f.status = 'ACTIVE'
              GROUP BY f.id, f.username, f.contact_name, f.phone
              ORDER BY MIN(r.read_at) IS NULL DESC, f.username",
            [$id, $id],
        );
        $map = static fn ($s) => [
            'franchiseId' => (int) $s['id'],
            'username'    => $s['username'],
            'contactName' => $s['contact_name'],
            'phone'       => $s['phone'],
            'readAt'      => $s['read_at'],
            'readBy'      => $s['first_reader'],
        ];

        return [
            'read'   => array_values(array_map($map, array_filter($shops, static fn ($s) => $s['read_at']))),
            'unread' => array_values(array_map($map, array_filter($shops, static fn ($s) => ! $s['read_at']))),
        ];
    }

    public static function create(array $input, array $actor): array
    {
        $id = Db::insert(
            'INSERT INTO announcements (title, body, category, pinned, starts_at, ends_at, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, COALESCE(?, UTC_DATE()), ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [
                trim($input['title']), trim($input['body']), $input['category'] ?? 'NEWS', ! empty($input['pinned']) ? 1 : 0,
                $input['startsAt'] ?? null, $input['endsAt'] ?? null, $actor['id'],
            ],
        );
        Audit::write((int) $actor['id'], 'announcement.create', 'announcement', $id, ['title' => $input['title']]);

        return self::get($id, $actor);
    }

    public static function get(int $id, array $user): array
    {
        $row = Db::one(
            'SELECT a.*, r.read_at, u.display_name AS author FROM announcements a
               LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
               LEFT JOIN users u ON u.id = a.created_by
              WHERE a.id = ?',
            [$user['id'], $id],
        );

        return self::serialize($row ?? throw ApiException::notFound('ไม่พบประกาศ'));
    }

    public static function update(int $id, array $input, array $actor): array
    {
        self::get($id, $actor);
        Db::exec(
            'UPDATE announcements
                SET title = COALESCE(?, title), body = COALESCE(?, body), category = COALESCE(?, category),
                    pinned = COALESCE(?, pinned), starts_at = COALESCE(?, starts_at), ends_at = ?,
                    updated_at = UTC_TIMESTAMP()
              WHERE id = ?',
            [
                isset($input['title']) ? trim($input['title']) : null,
                isset($input['body']) ? trim($input['body']) : null,
                $input['category'] ?? null,
                array_key_exists('pinned', $input) ? ($input['pinned'] ? 1 : 0) : null,
                $input['startsAt'] ?? null,
                $input['endsAt'] ?? null,
                $id,
            ],
        );
        Audit::write((int) $actor['id'], 'announcement.update', 'announcement', $id);

        return self::get($id, $actor);
    }

    public static function delete(int $id, array $actor): array
    {
        self::get($id, $actor);
        Db::exec('DELETE FROM announcements WHERE id = ?', [$id]);
        Audit::write((int) $actor['id'], 'announcement.delete', 'announcement', $id);

        return ['ok' => true];
    }

    public static function markRead(int $id, array $user): array
    {
        self::get($id, $user);
        Db::exec('INSERT IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, UTC_TIMESTAMP())', [$id, $user['id']]);

        return ['ok' => true];
    }
}
