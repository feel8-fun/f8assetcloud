

export const textEncoder = new TextEncoder();

export function bytesToHex(bytes) {
  let out = '';
  for (const value of bytes) {
    out += value.toString(16).padStart(2, '0');
  }
  return out;
}
