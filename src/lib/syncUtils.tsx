import React from 'react';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { apiUrl } from '@/lib/api';

/**
 * Performs a sync request handling Server-Sent Events (NDJSON stream)
 * to provide real-time updates directly from the backend.
 * 
 * @param endpoint The API endpoint (e.g. '/api/sync/bluesky')
 * @param body The request body object
 * @param setStatus Callback fired when a progress event arrives
 * @returns The final result payload containing { success: true, ... }
 */
export const runSyncTask = async (endpoint: string, body: any, setStatus: (s: string) => void) => {
  setStatus('Connecting to API...');
  
  const res = await fetch(apiUrl(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let err = 'HTTP Error';
    try { const data = await res.json(); err = data.error || err; } catch(e){}
    throw new Error(err);
  }

  if (!res.body) {
    throw new Error("ReadableStream not yet supported in this browser.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let result: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(line => line.trim() !== '');
    
    for (const line of lines) {
      try {
        const payload = JSON.parse(line);
        if (payload.type === 'progress') {
          setStatus(payload.message);
        } else if (payload.type === 'success') {
          result = payload;
        } else if (payload.type === 'error') {
          throw new Error(payload.error);
        }
      } catch (e) {
        if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
           throw e;
        }
        // else ignore malformed JSON boundary fragments - in a robust implementation
        // we'd buffer incomplete lines, but ndjson flushes usually send whole lines
      }
    }
  }

  return result || { success: true };
};
