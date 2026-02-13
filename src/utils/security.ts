const encoder = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...Array.from(bytes)));

const base64ToBytes = (value: string) =>
  new Uint8Array(Array.from(atob(value), (char) => char.charCodeAt(0)));

const ensureCrypto = () => {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前环境不支持加密能力");
  }
  return globalThis.crypto;
};

export const generateSalt = (length = 16) => {
  const crypto = ensureCrypto();
  const salt = new Uint8Array(length);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
};

export const hashMasterKey = async (password: string, saltBase64: string) => {
  const crypto = ensureCrypto();
  const salt = base64ToBytes(saltBase64);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
};

const deriveEncryptionKey = async (password: string, saltBase64: string) => {
  const crypto = ensureCrypto();
  const salt = base64ToBytes(saltBase64);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 120_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

export type EncryptedPayload = {
  __enc: 1;
  iv: string;
  data: string;
};

export const isEncryptedPayload = (value: unknown): value is EncryptedPayload =>
  !!value &&
  typeof value === "object" &&
  (value as EncryptedPayload).__enc === 1 &&
  typeof (value as EncryptedPayload).iv === "string" &&
  typeof (value as EncryptedPayload).data === "string";

export const encryptString = async (
  plain: string,
  password: string,
  saltBase64: string,
): Promise<EncryptedPayload> => {
  const crypto = ensureCrypto();
  const key = await deriveEncryptionKey(password, saltBase64);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plain),
  );
  return {
    __enc: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
};

export const decryptString = async (
  payload: EncryptedPayload,
  password: string,
  saltBase64: string,
) => {
  const crypto = ensureCrypto();
  const key = await deriveEncryptionKey(password, saltBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data),
  );
  return new TextDecoder().decode(decrypted);
};

export const verifyMasterKey = async (
  password: string,
  saltBase64: string,
  hashBase64: string,
) => {
  if (!hashBase64 || !saltBase64) return false;
  const next = await hashMasterKey(password, saltBase64);
  return next === hashBase64;
};
