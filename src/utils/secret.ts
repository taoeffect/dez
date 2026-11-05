const SECRET_TAG = Symbol('Secret')

/**
 * Hides a value from `toString()` and `JSON.stringify` (both give '[Secret]').
 * It is not a vault: `reveal()` returns the real value. So never log provider
 * request headers, native HTTP payloads, or diagnostic data without removing
 * secrets first.
 */
export class Secret<T> {
  readonly [SECRET_TAG] = true

  private constructor(private readonly value: T) {}

  static from<T>(value: T): Secret<T> {
    return new Secret(value)
  }

  reveal(): T {
    return this.value
  }

  toString(): string {
    return '[Secret]'
  }

  toJSON(): string {
    return '[Secret]'
  }
}

export function secret<T>(value: T): Secret<T> {
  return Secret.from(value)
}

export function isSecret<T = unknown>(value: unknown): value is Secret<T> {
  return value instanceof Secret
}
