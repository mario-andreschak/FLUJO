import { Suspense } from 'react';
import dynamicImport from 'next/dynamic';
import { Box } from '@mui/material';
import MemoryRoundedIcon from '@mui/icons-material/MemoryRounded';
import Spinner from '@/frontend/components/shared/Spinner';
import ScrollArea from '@/frontend/components/shared/ScrollArea';
import PageHeader from '@/frontend/components/shared/PageHeader';

// Use dynamic import to prevent SSR issues with client-side code
const ModelClient = dynamicImport(() => import('./ModelClient'), {
  loading: () => <Spinner />
});

export const dynamic = 'force-dynamic'; // Ensure dynamic rendering

function ModelsPage() {
  return (
      <Box
        data-tour="models-overview"
        sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <PageHeader
          eyebrowKey="models.header.eyebrow"
          titleKey="models.header.title"
          descriptionKey="models.header.description"
          icon={MemoryRoundedIcon}
          maxWidth="none"
        />
        <ScrollArea
          storageKey="flujo-ui:scroll:models"
          sx={{ p: { xs: 2, md: 3, lg: 4 }, flex: 1, width: '100%' }}
        >
          <Suspense fallback={<Spinner />}>
            <ModelClient />
          </Suspense>
        </ScrollArea>
      </Box>
  );
}

export default ModelsPage;
