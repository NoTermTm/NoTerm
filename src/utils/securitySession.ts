let masterKeySession: string | null = null;

export const setMasterKeySession = (value: string) => {
  masterKeySession = value;
};

export const clearMasterKeySession = () => {
  masterKeySession = null;
};

export const getMasterKeySession = () => masterKeySession;
