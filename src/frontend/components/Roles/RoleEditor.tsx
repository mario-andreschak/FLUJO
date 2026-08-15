'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppsRounded } from '@mui/icons-material';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Stack, TextField, Typography,
} from '@mui/material';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import { useMcpAppsDiscovery } from '@/frontend/components/mcp/useMcpAppsDiscovery';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { RolesApiError, rolesService } from '@/frontend/services/roles';

export default function RoleEditor({ mode, roleId }: { mode: 'create' | 'edit'; roleId?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [currentVersionId, setCurrentVersionId] = useState('');
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discovery = useMcpAppsDiscovery({ active: pickerOpen, includeAllServers: true });

  useEffect(() => {
    if (mode !== 'edit' || !roleId) return;
    void rolesService.get(roleId).then((role) => {
      setName(role.name);
      setPrompt(role.prompt);
      setCurrentVersionId(role.currentVersionId);
      setSelectedApps(role.suggestedApps.map((app) => app.mcpServerName));
    }).catch((caught) => {
      setError(caught instanceof RolesApiError ? caught.message : t('roles.loadFailed'));
    }).finally(() => setLoading(false));
  }, [mode, roleId, t]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const pickerItems = useMemo(() => discovery.servers.map((server) => {
    const selected = selectedApps.includes(server.name);
    return {
      key: server.name,
      label: server.name,
      searchText: `${server.name} ${server.apps.map((app) => app.name).join(' ')}`,
      selected,
      disabled: Boolean(server.error),
      onSelect: () => setSelectedApps((current) => (
        selected ? current.filter((name) => name !== server.name) : [...current, server.name]
      )),
      content: (
        <Card variant="outlined" sx={{ height: '100%', borderColor: selected ? 'primary.main' : 'divider' }}>
          <CardContent>
            <Typography variant="subtitle1" fontWeight={600}>{server.name}</Typography>
            <Typography variant="body2" color="text.secondary">
              {server.error ?? (server.apps.length > 0
                ? t('roles.apps.available', { count: server.apps.length })
                : t('roles.mcpServerAvailable'))}
            </Typography>
          </CardContent>
        </Card>
      ),
    };
  }), [discovery.servers, selectedApps, t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !prompt.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const suggestedApps = selectedApps.map((mcpServerName) => ({ mcpServerName }));
      const role = mode === 'create'
        ? await rolesService.create({ name: name.trim(), prompt: prompt.trim(), suggestedApps })
        : await rolesService.update(roleId!, {
          expectedCurrentVersionId: currentVersionId,
          name: name.trim(),
          prompt: prompt.trim(),
          suggestedApps,
        });
      setDirty(false);
      router.push(`/roles/${encodeURIComponent(role.id)}`);
    } catch (caught) {
      setError(caught instanceof RolesApiError ? caught.message : t('roles.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Stack alignItems="center" sx={{ p: 6 }}><CircularProgress /></Stack>;

  return (
    <Box component="main" sx={{ p: { xs: 2, md: 4 }, maxWidth: 760, mx: 'auto' }}>
      <Typography variant="h4" component="h1">{mode === 'create' ? t('roles.createTitle') : t('roles.editTitle')}</Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>{t('roles.editorDescription')}</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Box component="form" onSubmit={submit}>
        <Stack spacing={3}>
          <TextField
            required
            label={t('roles.name')}
            value={name}
            inputProps={{ maxLength: 160 }}
            onChange={(event) => { setName(event.target.value); setDirty(true); }}
          />
          <TextField
            required
            multiline
            minRows={5}
            label={t('roles.prompt')}
            helperText={t('roles.promptHelper')}
            value={prompt}
            inputProps={{ maxLength: 20000 }}
            onChange={(event) => { setPrompt(event.target.value); setDirty(true); }}
          />
          <Box>
            <Typography variant="subtitle1">{t('roles.suggestedApps')}</Typography>
            <Typography variant="body2" color="text.secondary">{t('roles.appsHelper')}</Typography>
            <Stack direction="row" gap={1} flexWrap="wrap" sx={{ my: 1.5 }}>
              {selectedApps.map((app) => <Chip key={app} label={app} onDelete={() => { setSelectedApps((current) => current.filter((name) => name !== app)); setDirty(true); }} />)}
            </Stack>
            <Button variant="outlined" startIcon={<AppsRounded />} onClick={() => setPickerOpen(true)}>
              {t('roles.chooseApps')}
            </Button>
          </Box>
          {mode === 'edit' && <Alert severity="info">{t('roles.saveCreatesVersion')}</Alert>}
          <Stack direction="row" justifyContent="flex-end" gap={1}>
            <Button onClick={() => router.back()}>{t('roles.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={saving || !name.trim() || !prompt.trim()}>
              {saving ? t('roles.saving') : t('roles.save')}
            </Button>
          </Stack>
        </Stack>
      </Box>
      <CardPickerDialog
        open={pickerOpen}
        onClose={() => { setPickerOpen(false); setDirty(true); }}
        title={t('roles.chooseApps')}
        description={t('roles.appsPickerHelp')}
        selectionMode="multiple"
        ariaLabel={t('roles.suggestedApps')}
        searchable
        searchPlaceholder={t('roles.searchApps')}
        isLoading={discovery.loading}
        error={discovery.error}
        emptyMessage={t('roles.appsEmpty')}
        items={pickerItems}
      />
    </Box>
  );
}
