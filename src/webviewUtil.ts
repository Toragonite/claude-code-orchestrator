/**
 * Serialize a value for embedding inside an inline <script> block. JSON alone
 * is not safe there: a "</script>" sequence inside any string would end the
 * script element, and U+2028/U+2029 are literal line terminators in JS source.
 * Localized strings are user-visible text from translation bundles, so this
 * runs on every injected strings object.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
