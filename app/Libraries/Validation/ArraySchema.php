<?php

namespace App\Libraries\Validation;

final class ArraySchema extends Schema
{
    private ?array $min = null;
    private ?array $max = null;

    public function __construct(private readonly Schema $item)
    {
    }

    public function min(int $n, ?string $message = null): self
    {
        $copy      = clone $this;
        $copy->min = [$n, $message];

        return $copy;
    }

    public function max(int $n, ?string $message = null): self
    {
        $copy      = clone $this;
        $copy->max = [$n, $message];

        return $copy;
    }

    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        if (! is_array($value) || ! array_is_list($value)) {
            self::invalidType($issues, $path, 'array', $value);

            return $value;
        }
        $out = [];
        foreach ($value as $i => $item) {
            $out[] = $this->item->run($item, [...$path, $i], $issues);
        }
        if ($this->min !== null && count($value) < $this->min[0]) {
            self::issue($issues, $path, $this->min[1] ?? "Too small: expected array to have >={$this->min[0]} items");
        }
        if ($this->max !== null && count($value) > $this->max[0]) {
            self::issue($issues, $path, $this->max[1] ?? "Too big: expected array to have <={$this->max[0]} items");
        }

        return $out;
    }
}
