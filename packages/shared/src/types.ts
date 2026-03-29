export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Provider {
  id: string;
  name: string;
  provider: string;
  createdAt: Date;
}

export interface UserProvider {
  userId: string;
  providerId: string;
  limits?: Record<string, any>;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  tokenHash?: string;
  token?: string;
  createdAt: Date;
  lastUsedAt?: Date;
  isActive: boolean;
}

export interface LogEntry {
  id?: string;
  timestamp: Date;
  userId: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source?: string;
  message: string;
  meta?: Record<string, any>;
}

export interface LogStats {
  rates: {
    m1: number;
    m5: number;
    m60: number;
  };
  topUsers: Array<{
    userId: string;
    count: number;
  }>;
  levelBreakdown: Record<string, number>;
}

export interface Summary {
  usersCount: number;
  providersCount: number;
  logRates: {
    m1: number;
    m5: number;
    m60: number;
  };
}

export interface ApiResponse<T = any> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface HealthCheck {
  status: 'ok' | 'error';
  service?: string;
  timestamp?: Date;
}
