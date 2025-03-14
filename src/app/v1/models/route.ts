import { NextResponse } from 'next/server';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { Flow } from '@/frontend/types/flow/flow';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/models/route');

export async function GET() {
  try {
    log.info('Fetching all flows for models endpoint');
    
    // Load all flows directly from storage
    const flows = await loadItem<Flow[]>(StorageKey.FLOWS, []);
    log.debug('Flows loaded successfully', { count: flows.length });
    
    // Transform flows into the required format
    const models = flows.map(flow => ({
      id: `flow-${flow.name}`,
      object: 'model'
    }));
    log.debug('Transformed flows into models', { modelCount: models.length });
    
    // Return the models in the OpenAI format
    log.info('Returning models in OpenAI format');
    return NextResponse.json({
      object: 'list',
      data: models
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
