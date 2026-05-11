const SECRET_TAG = Symbol('Secret')

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
