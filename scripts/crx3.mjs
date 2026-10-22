// Minimal, dependency-free CRX3 packer.
// Format: "Cr24" | u32 version=3 | u32 headerLen | CrxFileHeader (protobuf) | zip
// See chromium/src/components/crx_file/crx3.proto
import { createHash, createPrivateKey, createPublicKey, createSign } from 'node:crypto';

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

// Length-delimited protobuf field (wire type 2).
function field(num, bytes) {
  return Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes]);
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

export function publicKeyDer(pem) {
  return createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
}

// Extension ID: first 16 bytes of sha256(SPKI DER), hex digits mapped 0-f -> a-p.
export function extensionId(pem) {
  const hex = createHash('sha256').update(publicKeyDer(pem)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function packCrx3(zip, pem) {
  const pub = publicKeyDer(pem);
  const crxId = createHash('sha256').update(pub).digest().subarray(0, 16);
  const signedData = field(1, crxId); // SignedData { bytes crx_id = 1; }

  const signer = createSign('sha256');
  signer.update(Buffer.from('CRX3 SignedData\x00', 'binary'));
  signer.update(u32le(signedData.length));
  signer.update(signedData);
  signer.update(zip);
  const signature = signer.sign(createPrivateKey(pem));

  const proof = Buffer.concat([field(1, pub), field(2, signature)]); // AsymmetricKeyProof
  const header = Buffer.concat([
    field(2, proof), // sha256_with_rsa
    field(10000, signedData), // signed_header_data
  ]);
  return Buffer.concat([Buffer.from('Cr24'), u32le(3), u32le(header.length), header, zip]);
}
