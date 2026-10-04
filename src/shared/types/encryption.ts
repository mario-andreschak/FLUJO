/** Browser-safe status; never includes keys, passphrases, file paths or tokens. */
export interface EncryptionStatus {
  initialized: boolean;
  type: 'default' | 'user' | null;
  locked: boolean;
  recoveryRequired: boolean;
  protection: 'interactive' | 'operator' | 'legacy';
}
