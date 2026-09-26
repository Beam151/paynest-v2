<?php

namespace App\Libraries;

use App\Libraries\Validation\ArraySchema;
use App\Libraries\Validation\BooleanSchema;
use App\Libraries\Validation\EnumSchema;
use App\Libraries\Validation\NumberSchema;
use App\Libraries\Validation\ObjectSchema;
use App\Libraries\Validation\RecordSchema;
use App\Libraries\Validation\Schema;
use App\Libraries\Validation\StringSchema;
use App\Libraries\Validation\UnionSchema;

/**
 * ตัวช่วยสร้าง schema ตรวจ input (ชื่อเรียกเลียนแบบ zod ของระบบเดิม ให้เทียบโค้ดสองฝั่งได้ง่าย)
 *
 *   V::parse(V::object(['name' => V::string()->min(1)]), $body)
 *   ผิด = โยน ApiException 400 "ข้อมูลไม่ถูกต้อง" พร้อม details [{ field, message }]
 */
final class V
{
    public const DATE_RE   = '/^\d{4}-\d{2}-\d{2}$/';
    public const PERIOD_RE = '/^\d{4}-\d{2}-H[12]$/';
    public const HHMM_RE   = '/^([01]\d|2[0-3]):[0-5]\d$/';

    public static function string(?string $typeMessage = null): StringSchema
    {
        return new StringSchema($typeMessage);
    }

    public static function number(): NumberSchema
    {
        return new NumberSchema();
    }

    /** z.coerce.number() — "12" → 12 */
    public static function coerceNumber(): NumberSchema
    {
        return new NumberSchema(true);
    }

    public static function boolean(): BooleanSchema
    {
        return new BooleanSchema();
    }

    /** @param list<string> $values */
    public static function enum(array $values): EnumSchema
    {
        return new EnumSchema($values);
    }

    public static function array(Schema $item): ArraySchema
    {
        return new ArraySchema($item);
    }

    /** @param array<string, Schema> $shape */
    public static function object(array $shape): ObjectSchema
    {
        return new ObjectSchema($shape);
    }

    /** @param list<Schema> $options */
    public static function union(array $options): UnionSchema
    {
        return new UnionSchema($options);
    }

    public static function partialRecord(EnumSchema $keys, Schema $value): RecordSchema
    {
        return new RecordSchema($keys, $value);
    }

    public static function email(string $message): StringSchema
    {
        return (new StringSchema())->email($message);
    }

    /* ── ชนิดที่ใช้บ่อย (แบบเดียวกับ lib/validate.js ของตัวเดิม) ─────────── */

    /** จำนวนเงินรับได้ทั้ง number และ string ("1,250.50") */
    public static function amount(): UnionSchema
    {
        return self::union([self::number(), self::string()->min(1)]);
    }

    public static function pct(): UnionSchema
    {
        return self::union([self::number(), self::string()->min(1)]);
    }

    /** id จาก URL หรือ body — "12" ใช้ได้ */
    public static function id(): NumberSchema
    {
        return self::coerceNumber()->int()->positive();
    }

    public static function date(string $message = 'ต้องเป็นรูปแบบ YYYY-MM-DD'): StringSchema
    {
        return self::string()->regex(self::DATE_RE, $message);
    }

    public static function periodCode(?string $message = 'ต้องเป็นรูปแบบ YYYY-MM-H1 / YYYY-MM-H2'): StringSchema
    {
        return self::string()->regex(self::PERIOD_RE, $message);
    }

    /**
     * ตรวจ input แล้วคืนค่าที่ผ่านการตรวจ (object = อาเรย์ที่มีคีย์เฉพาะที่ประกาศไว้)
     *
     * @throws ApiException 400
     */
    public static function parse(Schema $schema, mixed $data, string $label = 'ข้อมูลไม่ถูกต้อง'): mixed
    {
        $issues = [];
        $value  = $schema->run($data, [], $issues);
        if ($issues !== []) {
            throw ApiException::badRequest($label, array_map(static fn ($i) => [
                'field'   => $i['path'] === [] ? '(root)' : implode('.', $i['path']),
                'message' => $i['message'],
            ], $issues));
        }

        return $value;
    }

    /** id จาก path — '12' → 12 · ผิดรูปแบบ = 400 */
    public static function parseId(mixed $raw): int
    {
        return self::parse(self::id(), $raw);
    }
}
