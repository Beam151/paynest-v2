<?php

namespace App\Libraries\Validation;

use App\Libraries\Js;

/** z.number() / z.coerce.number() — ค่าที่ได้เป็น int ถ้าเป็นจำนวนเต็ม */
final class NumberSchema extends Schema
{
    private bool $int = false;

    /** @var list<array{kind: string, value: float|int, inclusive: bool, message: ?string}> */
    private array $bounds = [];

    public function __construct(private readonly bool $coerce = false)
    {
    }

    public function int(): self
    {
        $copy      = clone $this;
        $copy->int = true;

        return $copy;
    }

    public function positive(?string $message = null): self
    {
        return $this->bound('min', 0, false, $message);
    }

    public function min(int|float $n, ?string $message = null): self
    {
        return $this->bound('min', $n, true, $message);
    }

    public function max(int|float $n, ?string $message = null): self
    {
        return $this->bound('max', $n, true, $message);
    }

    private function bound(string $kind, int|float $value, bool $inclusive, ?string $message): self
    {
        $copy           = clone $this;
        $copy->bounds[] = ['kind' => $kind, 'value' => $value, 'inclusive' => $inclusive, 'message' => $message];

        return $copy;
    }

    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        if ($this->coerce) {
            $value = Js::coerceNumber($value);
        }
        if (! (is_int($value) || is_float($value)) || is_nan((float) $value) || is_infinite((float) $value)) {
            self::invalidType($issues, $path, 'number', $value);

            return $value;
        }
        if ($this->int && (float) $value !== floor((float) $value)) {
            self::issue($issues, $path, 'Invalid input: expected int, received number');
        }
        foreach ($this->bounds as $b) {
            $v  = (float) $value;
            $op = $b['inclusive'] ? ($b['kind'] === 'min' ? '>=' : '<=') : ($b['kind'] === 'min' ? '>' : '<');
            $ok = match ($op) {
                '>=' => $v >= $b['value'],
                '>'  => $v > $b['value'],
                '<=' => $v <= $b['value'],
                default => $v < $b['value'],
            };
            if (! $ok) {
                $word = $b['kind'] === 'min' ? 'Too small' : 'Too big';
                self::issue($issues, $path, $b['message'] ?? "{$word}: expected number to be {$op}{$b['value']}");
            }
        }

        return is_float($value) && $value === floor($value) && abs($value) < PHP_INT_MAX ? (int) $value : $value;
    }
}
