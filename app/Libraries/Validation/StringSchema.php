<?php

namespace App\Libraries\Validation;

use App\Libraries\Js;

final class StringSchema extends Schema
{
    private bool $trim = false;

    /** @var list<array{kind: string, value: mixed, message: ?string}> */
    private array $checks = [];

    private ?string $typeMessage = null;

    public function __construct(?string $typeMessage = null)
    {
        $this->typeMessage = $typeMessage;
    }

    /** ตัดช่องว่างหัวท้ายก่อนตรวจ (ค่าที่ได้ก็ถูกตัดแล้ว) */
    public function trim(): self
    {
        $copy       = clone $this;
        $copy->trim = true;

        return $copy;
    }

    public function min(int $n, ?string $message = null): self
    {
        return $this->with('min', $n, $message);
    }

    public function max(int $n, ?string $message = null): self
    {
        return $this->with('max', $n, $message);
    }

    public function regex(string $pattern, ?string $message = null): self
    {
        return $this->with('regex', $pattern, $message);
    }

    public function email(?string $message = null): self
    {
        return $this->with('email', null, $message);
    }

    private function with(string $kind, mixed $value, ?string $message): self
    {
        $copy           = clone $this;
        $copy->checks[] = ['kind' => $kind, 'value' => $value, 'message' => $message];

        return $copy;
    }

    protected function check(mixed $value, array $path, array &$issues): mixed
    {
        if (! is_string($value)) {
            self::invalidType($issues, $path, 'string', $value, $this->typeMessage);

            return $value;
        }
        if ($this->trim) {
            $value = Js::trim($value);
        }
        foreach ($this->checks as $c) {
            switch ($c['kind']) {
                case 'min':
                    if (self::len($value) < $c['value']) {
                        self::issue($issues, $path, $c['message'] ?? "Too small: expected string to have >={$c['value']} characters");
                    }
                    break;

                case 'max':
                    if (self::len($value) > $c['value']) {
                        self::issue($issues, $path, $c['message'] ?? "Too big: expected string to have <={$c['value']} characters");
                    }
                    break;

                case 'regex':
                    if (! preg_match($c['value'], $value)) {
                        self::issue($issues, $path, $c['message'] ?? 'Invalid string: must match pattern ' . self::jsPattern($c['value']));
                    }
                    break;

                case 'email':
                    // รูปแบบเดียวกับที่ zod ใช้ตรวจอีเมล (ไม่ยอมจุดติดกัน / จุดหัวท้ายของส่วนชื่อ)
                    $re = '/^(?!\.)(?!.*\.\.)([A-Za-z0-9_\'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/';
                    if (! preg_match($re, $value)) {
                        self::issue($issues, $path, $c['message'] ?? 'Invalid email address');
                    }
                    break;
            }
        }

        return $value;
    }

    /** '/^\d+$/u' → '/^\d+$/' ให้ข้อความเหมือนฝั่ง JavaScript */
    private static function jsPattern(string $pattern): string
    {
        return preg_replace('/\/[a-z]*$/', '/', $pattern) ?? $pattern;
    }
}
