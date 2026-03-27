import { v7 as uuidv7 } from 'uuid'

/** Generate a time-ordered UUID v7. Monotonically increasing within ms boundaries. */
export function generateId(): string {
  return uuidv7()
}
