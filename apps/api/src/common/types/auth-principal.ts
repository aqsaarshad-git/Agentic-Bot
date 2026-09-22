export type AuthPrincipalType = 'user' | 'customer';

export interface AuthPrincipal {
  sub: string;
  type: AuthPrincipalType;
  email?: string;
  role?: string;
}
