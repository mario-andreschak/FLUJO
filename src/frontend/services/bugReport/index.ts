import { createLogger } from '@/utils/logger';
import { EnhanceResult, SafeBugContext } from '@/shared/types/bugReport';

const log = createLogger('frontend/services/bugReport');

/**
 * Frontend service for the Bug Report feature (issue #127). Follows the standard
 * domain-service convention: a class instance with a private fetch wrapper.
 *
 * The only network call is the opt-in AI enhancement (`/api/bugs/enhance`). Model API
 * keys never touch the browser — the enhancement runs entirely backend-side.
 */
class BugReportService {
  private async fetchWithErrorHandling(url: string, options?: RequestInit): Promise<any> {
    log.debug('Making API request', { url, method: options?.method || 'GET' });
    const response = await fetch(url, options);
    let data: any = null;
    if (response.status !== 204) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }
    }
    if (!response.ok) {
      const errorMessage =
        typeof data === 'object' && data !== null
          ? data.error || data.message || JSON.stringify(data)
          : data || `HTTP error! status: ${response.status}`;
      log.error('Request failed', { url, status: response.status, error: errorMessage });
      throw new Error(errorMessage);
    }
    return data;
  }

  /**
   * Ask the backend to polish/classify a draft bug report with a user-selected model.
   * Fails soft server-side: on model error the original text is returned with
   * `enhanced: false`, so the caller can always proceed.
   */
  async enhance(params: {
    modelId: string;
    title: string;
    description: string;
    context: SafeBugContext;
  }): Promise<EnhanceResult> {
    return this.fetchWithErrorHandling('/api/bugs/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }
}

export const bugReportService = new BugReportService();
