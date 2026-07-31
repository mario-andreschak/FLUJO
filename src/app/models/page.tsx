import { Suspense } from 'react';
import dynamicImport from 'next/dynamic';
import { Box } from '@mui/material';
import MemoryRoundedIcon from '@mui/icons-material/MemoryRounded';
import { createLogger } from '@/utils/logger';
import * as serverAdapter from '@/app/api/model/backend-model-adapter';
import Spinner from '@/frontend/components/shared/Spinner';
import ScrollArea from '@/frontend/components/shared/ScrollArea';
import PageHeader from '@/frontend/components/shared/PageHeader';

// Use dynamic import to prevent SSR issues with client-side code
const ModelClient = dynamicImport(() => import('./ModelClient'), {
  loading: () => <Spinner />
});

const log = createLogger('app/models/page');

export const dynamic = 'force-dynamic'; // Ensure dynamic rendering

// Async server component
async function ModelsPage() {
  log.debug('Rendering ModelsPage');
  
  try {
    // Fetch models on the server using the server adapter
    const models = await serverAdapter.loadModels();
    log.debug('Models loaded successfully', { count: models.length });
    
    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <PageHeader
          eyebrow="Step 1"
          title="AI Setup"
          description="Connect the AI provider FLUJO will use for every agent and conversation."
          icon={MemoryRoundedIcon}
          maxWidth="none"
        />
        <ScrollArea
          storageKey="flujo-ui:scroll:models"
          sx={{ p: { xs: 2, md: 3, lg: 4 }, flex: 1, width: '100%' }}
        >
          <Suspense fallback={<Spinner />}>
            <ModelClient initialModels={models} />
          </Suspense>
        </ScrollArea>
      </Box>
    );
  } catch (error) {
    log.error('Error loading models:', error);
    throw error; // This will be caught by the error boundary
  }
}

export default ModelsPage;
