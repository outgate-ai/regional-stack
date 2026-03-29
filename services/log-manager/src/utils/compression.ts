/**
 * Compression/Decompression Utilities
 * Reusable utilities for handling compressed HTTP responses
 */

import { gunzipSync, inflateSync, brotliDecompressSync } from 'zlib';

interface DecompressionResult {
  success: boolean;
  data: string | Buffer;
  originalSize: number;
  decompressedSize: number;
  encoding: string;
  error?: string;
}

/**
 * Attempts to decompress data based on content encoding
 */
export function decompressData(data: Buffer | string, encoding: string): DecompressionResult {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const result: DecompressionResult = {
    success: false,
    data: buffer,
    originalSize: buffer.length,
    decompressedSize: 0,
    encoding,
  };

  try {
    let decompressed: Buffer;

    switch (encoding.toLowerCase()) {
      case 'gzip':
        decompressed = gunzipSync(buffer);
        break;
      case 'deflate':
        decompressed = inflateSync(buffer);
        break;
      case 'br':
      case 'brotli':
        decompressed = brotliDecompressSync(buffer);
        break;
      default:
        // No compression or unknown encoding
        result.data = buffer.toString('utf8');
        result.decompressedSize = buffer.length;
        result.success = true;
        return result;
    }

    result.data = decompressed.toString('utf8');
    result.decompressedSize = decompressed.length;
    result.success = true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Decompression failed';
    result.error = `${errorMsg} (first bytes: ${getFirstBytes(buffer)})`;
    result.data = tryFallbackExtraction(buffer, encoding);
    result.success = false;
  }

  return result;
}

/**
 * Get first few bytes of buffer as hex string for debugging
 */
function getFirstBytes(buffer: Buffer, count: number = 16): string {
  const bytes = buffer.slice(0, Math.min(count, buffer.length));
  return (
    bytes
      .toString('hex')
      .match(/.{1,2}/g)
      ?.join(' ') || ''
  );
}

/**
 * Fallback extraction for when proper decompression fails
 */
function tryFallbackExtraction(buffer: Buffer, encoding: string): string {
  try {
    // First, try treating the buffer as plain UTF-8 text
    // This handles cases where Content-Encoding header is wrong (claims compression but content is uncompressed)
    const plainText = buffer.toString('utf8');

    // Check if it looks like valid text (not binary garbage)
    // Valid text should have mostly printable characters
    const printableChars = plainText.split('').filter((c) => {
      const code = c.charCodeAt(0);
      return (code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13;
    }).length;

    const printableRatio = printableChars / plainText.length;

    // If more than 80% of characters are printable, treat as plain text
    if (printableRatio > 0.8) {
      return plainText;
    }

    // If plain text extraction didn't work, try extracting JSON from binary data
    const data = buffer.toString('binary');

    // Look for JSON patterns in the compressed data
    const jsonPatterns = [
      /"data":\s*\[/,
      /"object":\s*"list"/,
      /"id":\s*"[^"]*"/,
      /"created":\s*\d+/,
      /"model":\s*"[^"]*"/,
    ];

    let bestMatch: RegExpMatchArray | null = null;
    let bestIndex = Infinity;

    for (const pattern of jsonPatterns) {
      const match = data.match(pattern);
      if (match && match.index !== undefined && match.index < bestIndex) {
        bestMatch = match;
        bestIndex = match.index;
      }
    }

    if (bestMatch && bestMatch.index !== undefined) {
      // Try to extract JSON starting from the best match
      const startIndex = Math.max(0, bestMatch.index - 50);
      const jsonStart = data.indexOf('{', startIndex);

      if (jsonStart !== -1) {
        let braceCount = 0;
        let jsonEnd = -1;

        for (let i = jsonStart; i < data.length; i++) {
          if (data[i] === '{') {
            braceCount++;
          } else if (data[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i;
              break;
            }
          }
        }

        if (jsonEnd !== -1) {
          const extracted = data.substring(jsonStart, jsonEnd + 1);
          // Clean up any remaining binary characters
          // eslint-disable-next-line no-control-regex
          const cleaned = extracted.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

          // Validate it looks like JSON
          if (cleaned.length > 10 && cleaned.trim().startsWith('{')) {
            return cleaned;
          }
        }
      }
    }

    // If all extraction methods fail, return a descriptive error message
    // Include hex representation of first bytes for debugging instead of garbled binary
    return JSON.stringify({
      error: `${encoding.toUpperCase()} compressed response - decompression failed`,
      originalSize: buffer.length,
      firstBytesHex: getFirstBytes(buffer, 32),
      encoding,
      note: 'Response body could not be decompressed or extracted. This typically indicates incomplete data capture, wrong encoding header, or corrupted data.',
    });
  } catch (err) {
    return JSON.stringify({
      error: 'Failed to process compressed response',
      originalSize: buffer.length,
      encoding,
      details: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

/**
 * Checks if data appears to be compressed (binary, not printable text)
 */
export function isCompressed(data: string | Buffer): boolean {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length < 2) return false;

  // Check for gzip magic bytes
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return true;

  // Check if data is mostly non-printable (binary)
  const sample = buffer.slice(0, Math.min(100, buffer.length));
  const printableChars = Array.from(sample).filter((b) => {
    return (b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13;
  }).length;

  return printableChars / sample.length < 0.8;
}

/**
 * Detects content encoding from headers
 */
export function detectEncoding(headers: Record<string, string | string[]>): string {
  const encoding = headers['content-encoding'] || headers['Content-Encoding'];
  if (Array.isArray(encoding)) {
    return encoding[0] || '';
  }
  return encoding || '';
}

/**
 * Safely attempts to parse JSON from potentially compressed data
 */
export function parseResponseBody(
  body: string | Buffer,
  headers: Record<string, string | string[]>
): { success: boolean; data: any; raw: string; compressionInfo?: DecompressionResult } {
  const encoding = detectEncoding(headers);

  if (encoding) {
    const decompressionResult = decompressData(body, encoding);

    try {
      const parsed = JSON.parse(decompressionResult.data.toString());
      return {
        success: true,
        data: parsed,
        raw: decompressionResult.data.toString(),
        compressionInfo: decompressionResult,
      };
    } catch {
      return {
        success: false,
        data: null,
        raw: decompressionResult.data.toString(),
        compressionInfo: decompressionResult,
      };
    }
  } else {
    // No compression
    try {
      const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      const parsed = JSON.parse(bodyStr);
      return {
        success: true,
        data: parsed,
        raw: bodyStr,
      };
    } catch {
      const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      return {
        success: false,
        data: null,
        raw: bodyStr,
      };
    }
  }
}
