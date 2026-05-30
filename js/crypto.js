// Tiny crypto primitives. Pure — no DOM, no storage, no state.
// Currently just base64 byte ↔ string helpers; storage.js owns the rest of the
// encryption stack (AES-GCM, KDF, envelope format). Future phases can pull
// more pure helpers in here as the storage code gets refactored.

export function b64Enc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64Dec(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
