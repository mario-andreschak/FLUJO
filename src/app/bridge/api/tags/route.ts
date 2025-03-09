import { NextResponse } from 'next/server';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { Flow } from '@/frontend/types/flow/flow';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/bridge/api/tags/route');

export async function GET() {
  try {
    log.info('Fetching all flows for tags endpoint (Ollama format)');
    
    // Load all flows directly from storage
    const flows = await loadItem<Flow[]>(StorageKey.FLOWS, []);
    log.debug('Flows loaded successfully', { count: flows.length });
    
    // Transform flows into the Ollama format
    const models = flows.map(flow => ({
      name: `flow-${flow.name}`,
      modified_at: new Date().toISOString(),
      size: 0,
      digest: "",
      details: {
        format: "",
        family: "",
        families: null,
        parameter_size: "",
        quantization_level: ""
      }
    }));
    log.debug('Transformed flows into Ollama format', { modelCount: models.length });
    
    // Return the models in the Ollama format
    log.info('Returning models in Ollama format');
    return NextResponse.json({
      models: models
    });
  } catch (error) {
    log.error('Error fetching models', error);
    return NextResponse.json(
      { 
        error: {
          message: 'Failed to fetch models',
          type: 'internal_error',
          code: 'internal_error'
        }
      },
      { status: 500 }
    );
  }
}
