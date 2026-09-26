<?php

namespace App\Libraries\Validation;

final class BooleanSchema extends Schema
{
    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        if (! is_bool($value)) {
            self::invalidType($issues, $path, 'boolean', $value);
        }

        return $value;
    }
}
