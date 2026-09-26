<?php

namespace App\Libraries\Validation;

/**
 * z.partialRecord(z.enum([...]), valueSchema) — ส่งมาเฉพาะคีย์ที่แก้ก็ได้ แต่คีย์ต้องอยู่ในชุดที่รู้จัก
 */
final class RecordSchema extends Schema
{
    public function __construct(private readonly EnumSchema $keys, private readonly Schema $value)
    {
    }

    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        $map = ObjectSchema::asMap($value);
        if ($map === null) {
            self::invalidType($issues, $path, 'record', $value);

            return $value;
        }
        $out = [];
        foreach ($map as $key => $item) {
            $key = (string) $key;
            if (! in_array($key, $this->keys->values(), true)) {
                self::issue($issues, [...$path, $key], 'Invalid key in record');

                continue;
            }
            $out[$key] = $this->value->run($item, [...$path, $key], $issues);
        }

        return $out;
    }
}
