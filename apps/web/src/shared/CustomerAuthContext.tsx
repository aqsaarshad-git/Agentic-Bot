import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import type { Customer, CustomerIdentifyResponse, CustomerOtpVerifyResponse } from 'shared-types';
import { apiFetch } from './api';

interface CustomerAuthState {
  token: string | null;
  customer: Customer | null;
  loading: boolean;
  identify: (fullName: string, contact: { email?: string; phone?: string }) => Promise<CustomerIdentifyResponse>;
  verifyOtp: (customerId: string, code: string) => Promise<void>;
  logout: () => void;
}

const STORAGE_KEY = 'customer_auth';

const CustomerAuthContext = createContext<CustomerAuthState | undefined>(undefined);

export function CustomerAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CustomerOtpVerifyResponse;
        setToken(parsed.accessToken);
        setCustomer(parsed.customer);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setLoading(false);
  }, []);

  async function identify(fullName: string, contact: { email?: string; phone?: string }) {
    return apiFetch<CustomerIdentifyResponse>('/auth/customer-identify', {
      method: 'POST',
      body: { fullName, ...contact },
    });
  }

  async function verifyOtp(customerId: string, code: string) {
    const result = await apiFetch<CustomerOtpVerifyResponse>('/auth/customer-verify-otp', {
      method: 'POST',
      body: { customerId, code },
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    setToken(result.accessToken);
    setCustomer(result.customer);
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setCustomer(null);
  }

  return (
    <CustomerAuthContext.Provider value={{ token, customer, loading, identify, verifyOtp, logout }}>
      {children}
    </CustomerAuthContext.Provider>
  );
}

export function useCustomerAuth(): CustomerAuthState {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) throw new Error('useCustomerAuth must be used within CustomerAuthProvider');
  return ctx;
}
