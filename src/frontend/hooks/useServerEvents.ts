import { useState, useEffect, useCallback, useRef } from 'react';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/hooks/useServerEvents');

interface ServerEvent {
  type: string;
  serverName: string;
  status?: 'connected' | 'disconnected' | 'error';
  message?: string;
  timestamp: number;
  [key: string]: any;
}

/**
 * Custom hook for managing server events
 */
export function useServerEvents(serverName: string | null) {
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  /**
   * Handle an event from the server
   */
  const handleEvent = useCallback((event: any) => {
    log.debug(`Received event for ${serverName}:`, event);
    
    // Create a standardized event object
    const serverEvent: ServerEvent = {
      type: event.type || 'unknown',
      serverName: serverName || 'unknown',
      timestamp: Date.now(),
      ...event
    };
    
    // Special handling for error events
    if (serverEvent.type === 'error') {
      // Log error events more prominently
      log.warn(`Error event received for ${serverName}:`, serverEvent);
      
      // If this is a timeout error, add additional context
      if (serverEvent.source === 'timeout') {
        log.warn(`Tool execution timed out: ${serverEvent.message}`);
      }
    }
    
    setLastEvent(serverEvent);
  }, [serverName]);

  /**
   * Subscribe to events for the specified server
   */
  const subscribe = useCallback(() => {
    if (!serverName) {
      log.warn('Cannot subscribe to events: No server name provided');
      return false;
    }
    
    // Clean up any existing subscription
    if (unsubscribeRef.current) {
      log.debug(`Cleaning up existing subscription for ${serverName}`);
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    
    log.debug(`Subscribing to events for ${serverName}`);
    
    try {
      const unsubscribe = mcpService.subscribeToServerEvents(serverName, handleEvent);
      unsubscribeRef.current = unsubscribe;
      setIsSubscribed(true);
      return true;
    } catch (error) {
      log.error(`Failed to subscribe to events for ${serverName}:`, error);
      setIsSubscribed(false);
      return false;
    }
  }, [serverName, handleEvent]);

  /**
   * Unsubscribe from events
   */
  const unsubscribe = useCallback(() => {
    if (unsubscribeRef.current) {
      log.debug(`Unsubscribing from events for ${serverName}`);
      unsubscribeRef.current();
      unsubscribeRef.current = null;
      setIsSubscribed(false);
      return true;
    }
    return false;
  }, [serverName]);

  // Subscribe to events when the server name changes
  useEffect(() => {
    log.debug(`Server name changed to: ${serverName || 'null'}`);
    if (serverName) {
      subscribe();
    } else {
      unsubscribe();
    }
    
    // Clean up subscription when the component unmounts
    return () => {
      log.debug(`Cleaning up subscription for server: ${serverName || 'null'}`);
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [serverName, subscribe, unsubscribe]);

  return {
    lastEvent,
    isSubscribed,
    subscribe,
    unsubscribe
  };
}
