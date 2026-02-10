import type { AuthType } from "./ssh";

export interface AuthProfile {
  id: string;
  name: string;
  username: string;
  auth_type: AuthType;
  public_key?: string;
}
