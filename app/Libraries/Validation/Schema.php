<?php

namespace App\Libraries\Validation;

use App\Libraries\Js;
use App\Libraries\Undefined;
use stdClass;

/**
 * ตัวตรวจ input แบบเดียวกับ zod ที่ระบบเดิมใช้ — กฎและข้อความ error ต้องตรงกัน
 * เพราะหน้าเว็บ (ไม่ได้แก้เลย) แสดงข้อความพวกนี้ให้ผู้ใช้เห็นตรง ๆ
 *
 * ค่า "ไม่ได้ส่งมา" คือ Undefined (ต่างจาก null) · ผลลัพธ์ของ object ไม่มีคีย์ที่ไม่ได้ส่งมา
 * ใช้ผ่าน App\Libraries\V เช่น V::object([...])
 */
abstract class Schema
{
    protected bool $optional = false;
    protected bool $nullable = false;

    public function optional(): static
    {
        $copy           = clone $this;
        $copy->optional = true;

        return $copy;
    }

    public function nullable(): static
    {
        $copy           = clone $this;
        $copy->nullable = true;

        return $copy;
    }

    public function isOptional(): bool
    {
        return $this->optional;
    }

    /**
     * ตรวจค่า — ปัญหาที่เจอเติมลงใน $issues แล้วคืนค่าที่แปลงแล้ว (ค่าอาจไม่มีความหมายถ้ามีปัญหา)
     *
     * @param list<int|string> $path
     * @param list<array{path: list<int|string>, message: string}> $issues
     */
    final public function run(mixed $value, array $path, array &$issues): mixed
    {
        if ($value instanceof Undefined && $this->optional) {
            return $value;
        }
        if ($value === null && $this->nullable) {
            return null;
        }

        return $this->check($value, $path, $issues);
    }

    abstract protected function check(mixed $value, array $path, array &$issues): mixed;

    protected static function issue(array &$issues, array $path, string $message): void
    {
        $issues[] = ['path' => $path, 'message' => $message];
    }

    /** ชื่อชนิดของค่าที่ได้รับ แบบข้อความของ zod */
    public static function typeName(mixed $value): string
    {
        return match (true) {
            $value instanceof Undefined => 'undefined',
            $value === null             => 'null',
            is_bool($value)             => 'boolean',
            is_int($value)              => 'number',
            is_float($value)            => is_nan($value) ? 'NaN' : (is_infinite($value) ? 'Infinity' : 'number'),
            is_string($value)           => 'string',
            is_array($value)            => array_is_list($value) ? 'array' : 'object',
            $value instanceof stdClass  => 'object',
            default                     => 'object',
        };
    }

    protected static function invalidType(array &$issues, array $path, string $expected, mixed $value, ?string $message = null): void
    {
        self::issue($issues, $path, $message ?? 'Invalid input: expected ' . $expected . ', received ' . self::typeName($value));
    }

    /** ความยาวแบบ JavaScript */
    protected static function len(string $s): int
    {
        return Js::len($s);
    }
}
