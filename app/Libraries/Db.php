<?php

namespace App\Libraries;

use CodeIgniter\Database\BaseConnection;
use Config\Database;
use RuntimeException;
use Throwable;

/**
 * ทางเข้าฐานข้อมูลของ service ทั้งหมด — SQL ดิบพร้อม ? bindings (CI4 escape ให้)
 *
 * ใช้ SQL ตรง ๆ แทน Query Builder โดยตั้งใจ: ตรรกะเงินทุกบรรทัดพอร์ตมาจากระบบเดิม
 * ให้ SQL สองฝั่งเทียบกันบรรทัดต่อบรรทัดได้ เวลาตามหาว่ายอดไหนมาจากไหน
 *
 * ทุก connection ตั้ง time_zone เป็น UTC — DEFAULT CURRENT_TIMESTAMP จะได้เป็น UTC เหมือนค่าที่โค้ดใส่เอง
 * ตัวเลขกลับมาเป็น int (numberNative) ยกเว้นผลของ SUM() ที่ MySQL ส่งเป็น DECIMAL → ต้อง (int) เองทุกครั้ง
 */
final class Db
{
    private static ?BaseConnection $prepared = null;

    /** ความลึกของ tx() ที่ซ้อนกันอยู่ — ชั้นนอกสุดล้างธงผิดพลาดของ CI ก่อนเริ่ม */
    private static int $txDepth = 0;

    public static function conn(): BaseConnection
    {
        $db = Database::connect();
        if (self::$prepared !== $db) {
            $db->initialize();
            /*
             * query ที่พังภายใน transaction ต้องโยน exception เหมือนนอก transaction
             * ค่าตั้งต้นของ CI4 คือ "เงียบ" (คืน false + ตั้ง transStatus) แล้ว tx() ก็ commit ต่อไปทั้งที่บางคำสั่งไม่ได้ลง
             * เคยเกิดจริง: สองจอทำบิลค่าคอมพร้อมกัน → INSERT บรรทัดชน UNIQUE เงียบ ๆ แต่หัวบิลที่มียอดเต็มถูก commit
             * ได้บิลค่าคอม PENDING ที่ไม่มีรายการแต่มียอดให้จ่าย (ด่าน 409 ที่เขียนไว้ไม่เคยทำงาน)
             * เปิดแล้ว CI rollback ทั้งก้อนเองก่อนโยน → tx() rollback ซ้ำเป็น no-op แล้วโยนต่อ
             */
            $db->transException(true);
            $db->query("SET time_zone = '+00:00'");
            $db->query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION')");
            self::$prepared = $db;
        }

        return $db;
    }

    /** ปิด connection ทิ้ง (เช่นฐานข้อมูลรีสตาร์ตระหว่างที่ schedule:work รันค้างอยู่) — ครั้งหน้าต่อใหม่เอง */
    public static function reset(): void
    {
        if (self::$prepared !== null) {
            try {
                self::$prepared->close();
            } catch (Throwable) {
                // หลุดไปแล้วอยู่ดี
            }
        }
        self::$prepared = null;
    }

    /**
     * ล็อกระดับฐานข้อมูล (GET_LOCK) — ชื่อผูกกับฐานข้อมูล กันสองระบบบนเซิร์ฟเวอร์เดียวกันแย่งกัน
     * ผูกกับ connection: โปรเซสตายกลางทาง ล็อกก็ปล่อยเอง ไม่ค้าง
     */
    public static function lock(string $name, int $waitSeconds = 0): bool
    {
        return (int) self::val('SELECT GET_LOCK(CONCAT(DATABASE(), ?), ?)', [':' . $name, $waitSeconds]) === 1;
    }

    public static function unlock(string $name): void
    {
        self::val('SELECT RELEASE_LOCK(CONCAT(DATABASE(), ?))', [':' . $name]);
    }

    /** @return list<array<string, mixed>> */
    public static function all(string $sql, array $binds = []): array
    {
        return self::conn()->query($sql, $binds)->getResultArray();
    }

    /** @return array<string, mixed>|null */
    public static function one(string $sql, array $binds = []): ?array
    {
        $row = self::conn()->query($sql, $binds)->getRowArray();

        return is_array($row) ? $row : null;
    }

    /** ค่าคอลัมน์แรกของแถวแรก (ไม่มีแถว = null) */
    public static function val(string $sql, array $binds = []): mixed
    {
        $row = self::one($sql, $binds);

        return $row === null ? null : reset($row);
    }

    /** ตัวเลขจำนวนเต็ม (COUNT / SUM / COALESCE) */
    public static function int(string $sql, array $binds = []): int
    {
        return (int) (self::val($sql, $binds) ?? 0);
    }

    /** INSERT/UPDATE/DELETE — คืนจำนวนแถวที่เปลี่ยน */
    public static function exec(string $sql, array $binds = []): int
    {
        $db = self::conn();
        $db->query($sql, $binds);

        return $db->affectedRows();
    }

    /** INSERT — คืน id ที่เพิ่งสร้าง */
    public static function insert(string $sql, array $binds = []): int
    {
        $db = self::conn();
        $db->query($sql, $binds);

        return (int) $db->insertID();
    }

    /**
     * ห่อ callback ไว้ใน transaction เดียว — เรียกซ้อนกันได้ (ชั้นนอกสุดเป็นคน commit/rollback)
     * โยน exception อะไรออกมาก็ rollback ทั้งก้อน
     */
    public static function tx(callable $fn): mixed
    {
        $db = self::conn();
        if (self::$txDepth === 0) {
            // ธง transStatus ของ CI ค้างเป็น false หลัง query พังครั้งก่อน (โหมด strict) — ก้อนใหม่ต้องเริ่มจากสะอาด
            $db->resetTransStatus();
        }
        $db->transBegin();
        self::$txDepth++;
        try {
            $result = $fn();
            /*
             * กันอีกชั้น: มีคำสั่งไหนพังโดยไม่โยน (เช่นโค้ดใน callback จับ exception ไว้เองแล้วทำต่อ)
             * ห้าม commit เงียบ ๆ — ยอดหัวบิลกับรายการจะไม่ตรงกัน
             */
            if ($db->transStatus() === false) {
                throw new RuntimeException('transaction ล้มเหลว: มีคำสั่งฐานข้อมูลที่ไม่สำเร็จภายในทรานแซกชัน — ยกเลิกทั้งก้อน');
            }
            $db->transCommit();

            return $result;
        } catch (Throwable $e) {
            $db->transRollback();

            throw $e;
        } finally {
            self::$txDepth--;
        }
    }

    /**
     * error จากฐานข้อมูลที่เป็น "ข้อมูลขัดกับข้อกำหนด" (ซ้ำ / FK / CHECK / trigger)
     * ตอบ 409 โดยไม่เผยชื่อตาราง-คอลัมน์ออกไป
     */
    public static function isConstraintError(Throwable $e): bool
    {
        $codes = [1022, 1048, 1062, 1169, 1216, 1217, 1451, 1452, 1557, 1644, 3819, 4025];
        for ($x = $e; $x !== null; $x = $x->getPrevious()) {
            if (in_array((int) $x->getCode(), $codes, true)) {
                return true;
            }
        }

        return false;
    }
}
