"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import SortIcon from '@mui/icons-material/Sort';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import UpdateIcon from '@mui/icons-material/Update';
import LayersIcon from '@mui/icons-material/Layers';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import { PlannedExecution, TriggerType } from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionListEntry,
} from '@/frontend/services/plannedExecutions';
import { createLogger } from '@/utils/logger';
import {
  CardGroup,
  collectFolders,
  DEFAULT_CARD_GROUP_MODE,
  groupByFolder,
  groupItems,
} from '@/utils/shared/cardGrouping';
import {
  matchesPlannedExecutionSearch,
  matchesPlannedExecutionStatus,
  plannedExecutionStateGroup,
  plannedExecutionTriggerGroup,
  PlannedExecutionFilter,
  PlannedExecutionSortOption,
  sortPlannedExecutions,
  TRIGGER_TYPE_LABELS,
} from '@/utils/shared/plannedExecutionGrouping';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
import { useAutoFocusSearch } from '@/frontend/hooks/useAutoFocusSearch';
import { useListScrollNav } from '@/frontend/hooks/useListScrollNav';
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';
import PageHeader from '@/frontend/components/shared/PageHeader';
import StickySearchBar from '@/frontend/components/shared/StickySearchBar';
import ScrollNavCluster from '@/frontend/components/shared/ScrollNavCluster';
import { useThemeUtils } from '@/frontend/utils/theme';
import ExecutionCard from './ExecutionCard';
import ExecutionModal from './ExecutionModal';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/PlannedExecutions');

type GroupMode = 'none' | 'folder' | 'trigger' | 'status';

/**
 * Automation Triggers page: manage flows that run headlessly on triggers.
 */
const PlannedExecutionsManager = () => {
  const theme = useTheme();
  const { t, tp, formatNumber } = useI18n();
  const { visualStyle } = useThemeUtils();
  const modern = visualStyle === 'modern';
  const [entries, setEntries] = useState<PlannedExecutionListEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedExecution | null>(null);
  const [deleting, setDeleting] = useState<PlannedExecution | null>(null);
  // Surfaces a failed enable/disable toggle instead of silently reverting on
  // the next poll (issue #118).
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  // #372: caret placed automatically; this page scrolls the document, so the
  // search toolbar also needs to stay pinned while scrolling (see wrapper below).
  const searchInputRef = useAutoFocusSearch();
  const [statusFilter, setStatusFilter] = useUiPreference<PlannedExecutionFilter>(
    'flujo-ui:planned-executions:filter',
    'all',
  );
  const [triggerFilter, setTriggerFilter] = useUiPreference<'all' | TriggerType>(
    'flujo-ui:planned-executions:trigger',
    'all',
  );
  const [sortOption, setSortOption] = useUiPreference<PlannedExecutionSortOption>(
    'flujo-ui:planned-executions:sort',
    'name-asc',
  );
  const [groupMode, setGroupMode] = useUiPreference<GroupMode>(
    'flujo-ui:planned-executions:group',
    DEFAULT_CARD_GROUP_MODE,
  );
  const [collapsedList, setCollapsedList] = useUiPreference<string[]>(
    'flujo-ui:planned-executions:collapsed',
    [],
  );
  const [sortAnchorEl, setSortAnchorEl] = useState<null | HTMLElement>(null);
  const [groupAnchorEl, setGroupAnchorEl] = useState<null | HTMLElement>(null);
  const collapsedKeys = useMemo(() => new Set(collapsedList), [collapsedList]);

  const refresh = useCallback(async () => {
    const response = await plannedExecutionsService.list();
    setEntries(response.executions);
    setPaused(response.paused);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Triggers fire in the background (schedules, external webhooks, watchers),
  // so poll for fresh statuses while the page is actually being looked at.
  // While any execution is mid-run, tighten the cadence so the live
  // "Running… → completed/error" transition surfaces within a few seconds
  // instead of up to 10s (issue #50); relax back to 10s when nothing runs.
  const anyRunning = entries.some(entry => entry.status.running);
  useEffect(() => {
    const intervalMs = anyRunning ? 3_000 : 10_000;
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, anyRunning]);

  const handleTogglePaused = async (nextPaused: boolean) => {
    setPaused(nextPaused); // optimistic
    const result = await plannedExecutionsService.setPaused(nextPaused);
    if (!result.success) {
      log.warn('Failed to toggle pause', result.error);
    }
    void refresh();
  };

  const handleToggleEnabled = async (execution: PlannedExecution, enabled: boolean) => {
    const result = await plannedExecutionsService.update(execution.id, { enabled });
    if (!result.success) {
      // Don't let the switch silently snap back on the next poll with no
      // explanation — tell the user why it didn't take.
      const message = result.error || t('automations.list.updateFailed');
      log.warn('Failed to toggle enabled', message);
      setToggleError(message);
    }
    void refresh();
  };

  const handleSetFolder = async (execution: PlannedExecution, folder: string | undefined) => {
    // JSON omits undefined values, so an empty string is the explicit
    // "remove folder" patch. The scheduler normalizes it back to undefined.
    const result = await plannedExecutionsService.update(execution.id, {
      folder: folder ?? '',
    });
    if (!result.success) {
      const message = result.error || t('automations.list.moveFailed');
      log.warn('Failed to update folder', message);
      setToggleError(message);
    }
    void refresh();
  };

  const handleDelete = async () => {
    if (!deleting) return;
    await plannedExecutionsService.delete(deleting.id);
    setDeleting(null);
    void refresh();
  };

  const folders = useMemo(
    () => collectFolders(entries, entry => entry.execution.folder),
    [entries],
  );

  const triggerLabel = (type: TriggerType) => t(`automations.list.trigger.${type}`);
  const sortLabel = (option: PlannedExecutionSortOption) => t(`automations.list.sort.${option}`);

  const filteredEntries = useMemo(() => {
    const localizedNeedle = searchTerm.trim().toLocaleLowerCase();
    const filtered = entries.filter(entry =>
      (matchesPlannedExecutionSearch(entry, searchTerm) ||
        Boolean(localizedNeedle && triggerLabel(entry.execution.trigger.type)
          .toLocaleLowerCase().includes(localizedNeedle))) &&
      matchesPlannedExecutionStatus(entry, statusFilter) &&
      (triggerFilter === 'all' || entry.execution.trigger.type === triggerFilter)
    );
    return sortPlannedExecutions(filtered, sortOption);
  }, [entries, searchTerm, statusFilter, triggerFilter, sortOption, t]);

  const groups = useMemo<CardGroup<PlannedExecutionListEntry>[]>(() => {
    if (groupMode === 'folder') {
      return groupByFolder(
        filteredEntries,
        entry => entry.execution.folder,
        t('automations.list.ungrouped'),
      );
    }
    if (groupMode === 'trigger') {
      return groupItems(filteredEntries, (entry) => {
        const group = plannedExecutionTriggerGroup(entry);
        return { ...group, label: triggerLabel(entry.execution.trigger.type) };
      });
    }
    if (groupMode === 'status') {
      return groupItems(filteredEntries, (entry) => {
        const group = plannedExecutionStateGroup(entry);
        const label = group.key === 'state:running'
          ? t('automations.list.running')
          : group.key === 'state:attention'
            ? t('automations.list.attention')
            : group.key === 'state:disabled'
              ? t('automations.list.off')
              : t('automations.list.active');
        return { ...group, label };
      });
    }
    return [];
  }, [filteredEntries, groupMode, t]);

  const toggleCollapsed = (key: string) => {
    setCollapsedList(previous =>
      previous.includes(key)
        ? previous.filter(item => item !== key)
        : [...previous, key],
    );
  };

  const clearFilters = () => {
    setSearchTerm('');
    setStatusFilter('all');
    setTriggerFilter('all');
  };

  const hasActiveFilters =
    searchTerm.trim() !== '' || statusFilter !== 'all' || triggerFilter !== 'all';

  const { ref: scrollRef, clusterProps: scrollNavProps } = useListScrollNav<HTMLDivElement>(
    'flujo-ui:scroll:automations',
    { deps: [loaded, filteredEntries.length], groupsEnabled: groupMode !== 'none' },
  );

  const renderEntries = (items: PlannedExecutionListEntry[]) => (
    <Box
      sx={modern
        ? {
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
            gap: 2,
            alignItems: 'start',
          }
        : { display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      {items.map(entry => (
        <ExecutionCard
          key={entry.execution.id}
          entry={entry}
          folders={folders}
          onSetFolder={(folder) => void handleSetFolder(entry.execution, folder)}
          onEdit={() => {
            setEditing(entry.execution);
            setModalOpen(true);
          }}
          onDelete={() => setDeleting(entry.execution)}
          onToggleEnabled={(enabled) => handleToggleEnabled(entry.execution, enabled)}
          onRanNow={() => void refresh()}
          paused={paused}
        />
      ))}
    </Box>
  );

  return (
    <Box ref={scrollRef} sx={{ width: '100%' }}>
      <PageHeader
        eyebrowKey="automations.list.eyebrow"
        titleKey="automations.list.title"
        descriptionKey="automations.list.description"
        icon={ScheduleRoundedIcon}
        maxWidth={1200}
        actions={(
          <>
          <Tooltip title={t('automations.list.refresh')}>
            <IconButton onClick={() => void refresh()} aria-label={t('automations.list.refreshAria')}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <FormControlLabel
            control={
              <Switch
                checked={!paused}
                onChange={(e) => handleTogglePaused(!e.target.checked)}
              />
            }
            label={paused ? t('automations.list.paused') : t('automations.list.active')}
          />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
            data-tour="add-execution"
          >
            {t('automations.list.add')}
          </Button>
          </>
        )}
      />

      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {t('automations.list.runningRequirement')}
      </Typography>

      {paused && entries.length > 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          {t('automations.list.pausedAlert')}
        </Alert>
      )}

      {entries.length > 0 && (
        <>
          <StickySearchBar mode="page">
          <Paper elevation={0} variant="outlined" sx={{ mb: 1.5, p: 1.2, borderRadius: 3 }}>
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', md: 'row' },
                gap: 1,
                alignItems: { xs: 'stretch', md: 'center' },
                justifyContent: 'space-between',
              }}
            >
              <TextField
                placeholder={t('automations.list.search')}
                variant="outlined"
                size="small"
                fullWidth
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                inputRef={searchInputRef}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
                sx={{ maxWidth: { md: 360 } }}
              />

              <Box
                sx={{
                  display: 'flex',
                  gap: 1,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <FormControl size="small" sx={{ minWidth: 130 }}>
                  <InputLabel id="execution-status-filter-label">{t('automations.list.status')}</InputLabel>
                  <Select
                    labelId="execution-status-filter-label"
                    label={t('automations.list.status')}
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as PlannedExecutionFilter)
                    }
                  >
                    <MenuItem value="all">{t('automations.list.allStatuses')}</MenuItem>
                    <MenuItem value="enabled">{t('automations.list.active')}</MenuItem>
                    <MenuItem value="disabled">{t('automations.list.off')}</MenuItem>
                    <MenuItem value="running">{t('automations.list.running')}</MenuItem>
                    <MenuItem value="attention">{t('automations.list.attention')}</MenuItem>
                  </Select>
                </FormControl>

                <FormControl size="small" sx={{ minWidth: 140 }}>
                  <InputLabel id="execution-trigger-filter-label">{t('automations.list.trigger')}</InputLabel>
                  <Select
                    labelId="execution-trigger-filter-label"
                    label={t('automations.list.trigger')}
                    value={triggerFilter}
                    onChange={(event) =>
                      setTriggerFilter(event.target.value as 'all' | TriggerType)
                    }
                  >
                    <MenuItem value="all">{t('automations.list.allTriggers')}</MenuItem>
                    {(Object.entries(TRIGGER_TYPE_LABELS) as Array<[TriggerType, string]>)
                      .map(([value]) => (
                        <MenuItem key={value} value={value}>{triggerLabel(value)}</MenuItem>
                      ))}
                  </Select>
                </FormControl>

                {hasActiveFilters && (
                  <Button size="small" onClick={clearFilters}>
                    {t('automations.list.clear')}
                  </Button>
                )}

                <Tooltip title={t('automations.list.groupCards')}>
                  <IconButton
                    size="small"
                    onClick={(event) => setGroupAnchorEl(event.currentTarget)}
                    color={groupMode !== 'none' ? 'primary' : 'default'}
                    aria-label={t('automations.list.groupCards')}
                    sx={{
                      border: `1px solid ${theme.palette.divider}`,
                      backgroundColor: theme.palette.background.default,
                    }}
                  >
                    <LayersIcon fontSize="small" />
                  </IconButton>
                </Tooltip>

                <Tooltip title={t('automations.list.sortTriggers')}>
                  <IconButton
                    size="small"
                    onClick={(event) => setSortAnchorEl(event.currentTarget)}
                    aria-label={t('automations.list.sortTriggers')}
                    sx={{
                      border: `1px solid ${theme.palette.divider}`,
                      backgroundColor: theme.palette.background.default,
                    }}
                  >
                    <SortIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          </Paper>
          </StickySearchBar>

          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
              mb: 2,
              px: 1,
            }}
          >
            <Typography variant="body2" color="text.secondary">
              {tp('automations.list.count', entries.length, {
                shown: formatNumber(filteredEntries.length),
                total: formatNumber(entries.length),
              })}
              {searchTerm && t('automations.list.matching', { search: searchTerm })}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('automations.list.sortedBy', { sort: sortLabel(sortOption) })}
            </Typography>
          </Box>
        </>
      )}

      {!loaded && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {loaded && entries.length === 0 && (
        <Box
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            borderStyle: 'dashed',
            p: 6,
            textAlign: 'center',
          }}
        >
          <Typography variant="h6" sx={{ mb: 1 }}>
            {t('automations.list.noTriggers')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('automations.list.noTriggersHelp')}
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            {t('automations.list.newTrigger')}
          </Button>
        </Box>
      )}

      {loaded && entries.length > 0 && filteredEntries.length === 0 && (
        <Box
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            borderStyle: 'dashed',
            p: 6,
            textAlign: 'center',
          }}
        >
          <Typography variant="h6" sx={{ mb: 1 }}>{t('automations.list.noMatches')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('automations.list.noMatchesHelp')}
          </Typography>
          <Button variant="outlined" onClick={clearFilters}>{t('automations.list.clearFilters')}</Button>
        </Box>
      )}

      {loaded && filteredEntries.length > 0 && (
        groupMode === 'none'
          ? renderEntries(filteredEntries)
          : groups.map(group => (
              <CollapsibleCardSection
                key={group.key}
                groupKey={group.key}
                label={group.label}
                count={group.items.length}
                expanded={!collapsedKeys.has(group.key)}
                onToggle={() => toggleCollapsed(group.key)}
                showFolderIcon={groupMode === 'folder'}
              >
                {renderEntries(group.items)}
              </CollapsibleCardSection>
            ))
      )}

      <Menu
        anchorEl={groupAnchorEl}
        open={Boolean(groupAnchorEl)}
        onClose={() => setGroupAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          selected={groupMode === 'none'}
          onClick={() => { setGroupMode('none'); setGroupAnchorEl(null); }}
        >
          <ListItemIcon><LayersClearIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('automations.list.group.none')} />
        </MenuItem>
        <MenuItem
          selected={groupMode === 'folder'}
          onClick={() => { setGroupMode('folder'); setGroupAnchorEl(null); }}
        >
          <ListItemIcon><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('automations.list.group.folder')} />
        </MenuItem>
        <MenuItem
          selected={groupMode === 'trigger'}
          onClick={() => { setGroupMode('trigger'); setGroupAnchorEl(null); }}
        >
          <ListItemIcon><BoltOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('automations.list.group.trigger')} />
        </MenuItem>
        <MenuItem
          selected={groupMode === 'status'}
          onClick={() => { setGroupMode('status'); setGroupAnchorEl(null); }}
        >
          <ListItemIcon><MonitorHeartOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('automations.list.group.status')} />
        </MenuItem>
      </Menu>

      <Menu
        anchorEl={sortAnchorEl}
        open={Boolean(sortAnchorEl)}
        onClose={() => setSortAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          selected={sortOption === 'name-asc'}
          onClick={() => { setSortOption('name-asc'); setSortAnchorEl(null); }}
        >
          <ListItemIcon><SortByAlphaIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={sortLabel('name-asc')} />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'name-desc'}
          onClick={() => { setSortOption('name-desc'); setSortAnchorEl(null); }}
        >
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary={sortLabel('name-desc')} />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'newest'}
          onClick={() => { setSortOption('newest'); setSortAnchorEl(null); }}
        >
          <ListItemIcon><UpdateIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={sortLabel('newest')} />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'oldest'}
          onClick={() => { setSortOption('oldest'); setSortAnchorEl(null); }}
        >
          <ListItemIcon>
            <UpdateIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary={sortLabel('oldest')} />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'last-run'}
          onClick={() => { setSortOption('last-run'); setSortAnchorEl(null); }}
        >
          <ListItemIcon><MonitorHeartOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={sortLabel('last-run')} />
        </MenuItem>
      </Menu>

      <ScrollNavCluster {...scrollNavProps} />

      <ExecutionModal
        open={modalOpen}
        execution={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => void refresh()}
      />

      <Snackbar
        open={toggleError !== null}
        autoHideDuration={6000}
        onClose={() => setToggleError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setToggleError(null)} sx={{ width: '100%' }}>
          {toggleError}
        </Alert>
      </Snackbar>

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)}>
        <DialogTitle>{t('automations.list.deleteTitle', { name: deleting?.name ?? '' })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {t('automations.list.deleteHelp')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t('automations.list.cancel')}</Button>
          <Button color="error" variant="contained" onClick={handleDelete}>
            {t('automations.list.delete')}
          </Button>
        </DialogActions>
      </Dialog>
      </Box>
    </Box>
  );
};

export default PlannedExecutionsManager;
