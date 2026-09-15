/**
 * HTTP utility for making REST API calls to Lavalink
 */

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  endpoint: string;
  headers?: Record<string, string>;
  body?: any;
}

export interface RequestConfig {
  host: string;
  port: number;
  password: string;
  secure: boolean;
}

export class HttpClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: RequestConfig) {
    const protocol = config.secure ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
    this.headers = {
      'Authorization': config.password,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Make a request to the Lavalink REST API
   */
  async request<T = any>(options: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${options.endpoint}`;
    const headers = { ...this.headers, ...options.headers };

    try {
      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      // Handle non-2xx status codes
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${response.statusText} - ${errorText}`
        );
      }

      // Handle empty responses (204 No Content)
      if (response.status === 204 || response.headers.get('content-length') === '0') {
        return {} as T;
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

      if (contentType.includes('application/json')) {
        const data = await response.json();
        return data as T;
      }

      // Lavalink `/version` returns plain text
      const text = await response.text();
      return text as T;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Request failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * GET request
   */
  async get<T = any>(endpoint: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>({ method: 'GET', endpoint, headers });
  }

  /**
   * POST request
   */
  async post<T = any>(
    endpoint: string,
    body?: any,
    headers?: Record<string, string>
  ): Promise<T> {
    return this.request<T>({ method: 'POST', endpoint, body, headers });
  }

  /**
   * PATCH request
   */
  async patch<T = any>(
    endpoint: string,
    body?: any,
    headers?: Record<string, string>
  ): Promise<T> {
    return this.request<T>({ method: 'PATCH', endpoint, body, headers });
  }

  /**
   * DELETE request
   */
  async delete<T = any>(endpoint: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>({ method: 'DELETE', endpoint, headers });
  }

  /**
   * Update base URL (for reconnection scenarios)
   */
  updateConfig(config: RequestConfig): void {
    const protocol = config.secure ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
    this.headers['Authorization'] = config.password;
  }
}
