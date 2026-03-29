export function formatError(code: string, message: string, details?: any) {
  return {
    error: {
      code,
      message,
      details,
    },
  };
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.substring(0, 4) + '****' + token.substring(token.length - 4);
}

export function parseEnvInt(value: string | undefined, defaultValue: number): number {
  const parsed = parseInt(value || '', 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
