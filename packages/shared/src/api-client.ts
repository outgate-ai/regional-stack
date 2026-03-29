interface FetchOptions extends RequestInit {
  baseUrl?: string;
  apiKey?: string;
}

export class ApiClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async fetch<T = any>(path: string, options: FetchOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      let errorData: any;
      try {
        errorData = await response.json();
      } catch {
        errorData = { error: { code: 'UNKNOWN', message: response.statusText } };
      }
      throw new Error(errorData.error?.message || `Request failed: ${response.status}`);
    }

    // Handle empty responses (like 204 No Content)
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return null as T;
    }

    return response.json() as Promise<T>;
  }

  async get<T = any>(path: string, options?: FetchOptions): Promise<T> {
    return this.fetch<T>(path, { ...options, method: 'GET' });
  }

  async post<T = any>(path: string, body?: any, options?: FetchOptions): Promise<T> {
    return this.fetch<T>(path, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async patch<T = any>(path: string, body?: any, options?: FetchOptions): Promise<T> {
    return this.fetch<T>(path, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete<T = any>(path: string, options?: FetchOptions): Promise<T> {
    return this.fetch<T>(path, { ...options, method: 'DELETE' });
  }
}

export function createInternalClient(serviceUrl: string, apiKey?: string): ApiClient {
  const key = apiKey || process.env.INTERNAL_API_KEY;
  return new ApiClient(serviceUrl, key);
}
