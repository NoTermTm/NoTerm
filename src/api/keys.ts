import { invoke } from "@tauri-apps/api/core";

export type GenerateKeyAlgorithm = "ed25519" | "rsa4096";

export interface GeneratedKeypair {
  key_path: string;
  public_key: string;
  algorithm: GenerateKeyAlgorithm;
  comment?: string;
}

export async function generateKeypair(input: {
  algorithm: GenerateKeyAlgorithm;
  name: string;
  passphrase?: string;
  comment?: string;
}): Promise<GeneratedKeypair> {
  return await invoke("ssh_generate_keypair", input);
}

