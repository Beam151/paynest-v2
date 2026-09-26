<?php

namespace App\Libraries\Validation;

/** z.union — ผ่านตัวเลือกแรกที่ตรง · ไม่ตรงเลย = "Invalid input" */
final class UnionSchema extends Schema
{
    /** @param list<Schema> $options */
    public function __construct(private readonly array $options)
    {
    }

    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        foreach ($this->options as $option) {
            $local  = [];
            $parsed = $option->run($value, $path, $local);
            if ($local === []) {
                return $parsed;
            }
        }
        self::issue($issues, $path, 'Invalid input');

        return $value;
    }
}
