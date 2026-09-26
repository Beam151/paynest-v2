<?php

namespace App\Libraries\Validation;

use App\Libraries\Undefined;
use stdClass;

/**
 * z.object — คีย์ที่ไม่รู้จักถูกตัดทิ้ง · คีย์ที่ไม่ได้ส่งมาจะไม่อยู่ในผลลัพธ์ (แยกจาก null ได้)
 */
final class ObjectSchema extends Schema
{
    /** @param array<string, Schema> $shape */
    public function __construct(private array $shape)
    {
    }

    /** @return array<string, Schema> */
    public function shape(): array
    {
        return $this->shape;
    }

    /** ทุกช่องไม่บังคับ (z.object().partial()) */
    public function partial(): self
    {
        $copy = clone $this;
        foreach ($copy->shape as $key => $schema) {
            $copy->shape[$key] = $schema->optional();
        }

        return $copy;
    }

    /** @param list<string> $keys */
    public function omit(array $keys): self
    {
        $copy = clone $this;
        foreach ($keys as $key) {
            unset($copy->shape[$key]);
        }

        return $copy;
    }

    /** @param array<string, Schema> $more */
    public function extend(array $more): self
    {
        $copy        = clone $this;
        $copy->shape = [...$copy->shape, ...$more];

        return $copy;
    }

    /** ค่าที่มาจาก JSON (stdClass) หรือจากโค้ด (อาเรย์ที่มีคีย์) → อาเรย์ที่มีคีย์ · อย่างอื่น null */
    public static function asMap(mixed $value): ?array
    {
        if ($value instanceof stdClass) {
            return get_object_vars($value);
        }
        if (is_array($value) && ($value === [] || ! array_is_list($value))) {
            return $value;
        }

        return null;
    }

    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        $map = self::asMap($value);
        if ($map === null) {
            self::invalidType($issues, $path, 'object', $value);

            return $value;
        }
        $out = [];
        foreach ($this->shape as $key => $schema) {
            $given = array_key_exists($key, $map) ? $map[$key] : Undefined::get();
            $parsed = $schema->run($given, [...$path, $key], $issues);
            if (! $parsed instanceof Undefined) {
                $out[$key] = $parsed;
            }
        }

        return $out;
    }
}
