import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/utils/oauth');

export interface OAuthPopupOptions {
  url: string;
  windowName?: string;
  width?: number;
  height?: number;
  onSuccess?: (result: any) => void;
  onError?: (error: string) => void;
  onClose?: () => void;
}

/**
 * Open OAuth popup window and handle the authentication flow
 */
export function openOAuthPopup(options: OAuthPopupOptions): Promise<any> {
  const {
    url,
    windowName = 'oauth_popup',
    width = 600,
    height = 700,
    onSuccess,
    onError,
    onClose
  } = options;

  return new Promise((resolve, reject) => {
    // Calculate popup position (center of screen)
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;

    // Popup window features
    const features = [
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      'scrollbars=yes',
      'resizable=yes',
      'status=no',
      'toolbar=no',
      'menubar=no',
      'location=no'
    ].join(',');

    log.info('Opening OAuth popup', { url: url.substring(0, 100) + '...', windowName });

    // Open popup window
    const popup = window.open(url, windowName, features);

    if (!popup) {
      const error = 'Failed to open popup window. Please check if popups are blocked.';
      log.error(error);
      onError?.(error);
      reject(new Error(error));
      return;
    }

    // Focus the popup
    popup.focus();

    // Poll for popup closure or URL changes
    const pollTimer = setInterval(() => {
      try {
        // Check if popup is closed
        if (popup.closed) {
          clearInterval(pollTimer);
          log.info('OAuth popup was closed by user');
          onClose?.();
          reject(new Error('OAuth popup was closed by user'));
          return;
        }

        // Try to access popup URL (will throw if cross-origin)
        let popupUrl: string;
        try {
          popupUrl = popup.location.href;
        } catch (e) {
          // Cross-origin, continue polling
          return;
        }

        // Check if we're back on our domain (callback URL)
        if (popupUrl.includes('/mcp')) {
          clearInterval(pollTimer);
          
          // Parse URL parameters
          const url = new URL(popupUrl);
          const oauthSuccess = url.searchParams.get('oauth_success');
          const oauthError = url.searchParams.get('oauth_error');
          const errorDescription = url.searchParams.get('error_description');

          // Close popup
          popup.close();

          if (oauthError) {
            const error = `OAuth error: ${oauthError}${errorDescription ? ` - ${errorDescription}` : ''}`;
            log.error('OAuth authentication failed', { oauthError, errorDescription });
            onError?.(error);
            reject(new Error(error));
          } else if (oauthSuccess) {
            log.info('OAuth authentication successful', { serverName: oauthSuccess });
            const result = { serverName: oauthSuccess };
            onSuccess?.(result);
            resolve(result);
          } else {
            const error = 'OAuth callback received but no success or error parameter found';
            log.error(error);
            onError?.(error);
            reject(new Error(error));
          }
        }
      } catch (error) {
        // Ignore cross-origin errors, continue polling
      }
    }, 1000);

    // Set timeout to prevent infinite polling
    setTimeout(() => {
      if (!popup.closed) {
        clearInterval(pollTimer);
        popup.close();
        const error = 'OAuth authentication timed out';
        log.error(error);
        onError?.(error);
        reject(new Error(error));
      }
    }, 300000); // 5 minutes timeout
  });
}

/**
 * Generate OAuth state parameter with server information
 */
export function generateOAuthState(serverName: string, redirectUri: string): string {
  const stateData = {
    serverName,
    redirectUri,
    timestamp: Date.now(),
    nonce: Math.random().toString(36).substring(2, 15)
  };
  
  return encodeURIComponent(JSON.stringify(stateData));
}

/**
 * Build OAuth authorization URL with proper parameters
 */
export function buildAuthorizationUrl(
  authorizationEndpoint: string,
  clientId: string,
  redirectUri: string,
  state: string,
  scopes: string[] = ['read'],
  codeChallenge?: string
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: scopes.join(' ')
  });

  // Add PKCE challenge if provided
  if (codeChallenge) {
    params.append('code_challenge', codeChallenge);
    params.append('code_challenge_method', 'S256');
  }

  return `${authorizationEndpoint}?${params.toString()}`;
}

/**
 * Generate PKCE code verifier and challenge
 */
export async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  // Generate code verifier (43-128 characters, URL-safe)
  const codeVerifier = generateRandomString(128);
  
  // Generate code challenge (SHA256 hash of verifier, base64url encoded)
  const hashBuffer = await sha256(codeVerifier);
  const codeChallenge = base64URLEncode(hashBuffer);
  
  return { codeVerifier, codeChallenge };
}

/**
 * Generate random string for PKCE
 */
function generateRandomString(length: number): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  
  for (let i = 0; i < length; i++) {
    result += charset[values[i] % charset.length];
  }
  
  return result;
}

/**
 * SHA256 hash function
 */
async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest('SHA-256', data);
}

/**
 * Base64URL encode
 */
function base64URLEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
