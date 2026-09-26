<?php

namespace App\Libraries\Validation;

final class EnumSchema extends Schema
{
    /** @param list<string> $values */
    public function __construct(private readonly array $values)
    {
    }

    public function values(): array
    {
        return $this->values;
    }

    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        if (! is_string($value) || ! in_array($value, $this->values, true)) {
            self::issue($issues, $path, 'Invalid option: expected one of ' . implode('|', array_map(
                static fn ($v) => '"' . $v . '"',
                $this->values,
            )));
        }

        return $value;
    }
}
