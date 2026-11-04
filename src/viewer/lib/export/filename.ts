const MAX_SANITIZED_CODE_UNITS = 100;
const UTF8_ENCODER = new TextEncoder();

/** Replace unmatched UTF-16 surrogates before serialization changes their identity. */
function makeWellFormed(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index++;
      } else {
        result += "\ufffd";
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index];
    }
  }

  return result;
}

/** Truncate to a UTF-16 code-unit limit without leaving a dangling high surrogate. */
function truncateUtf16Safely(value: string, maxCodeUnits: number): string {
  let result = value.substring(0, maxCodeUnits);
  const lastCodeUnit = result.charCodeAt(result.length - 1);

  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Sanitize a name for use as a cross-platform filename.
 *
 * Individual workout downloads keep the historical 100-code-unit limit. Bulk
 * archives add their own final UTF-8 byte budget after date and suffix fields.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = makeWellFormed(name)
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

  return truncateUtf16Safely(cleaned, MAX_SANITIZED_CODE_UNITS);
}

/** Return the UTF-8 byte length used by ZIP entries and common filesystems. */
export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(makeWellFormed(value)).length;
}

/** Truncate a string to a UTF-8 byte budget without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";

  let result = "";
  let bytes = 0;

  for (const character of makeWellFormed(value)) {
    const characterBytes = UTF8_ENCODER.encode(character).length;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }

  return result;
}
