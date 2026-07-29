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
  PLANNED_EXECUTION_SORT_LABELS,
  sortPlannedExecutions,
  TRIGGER_TYPE_LABELS,
} from '@/utils/shared/plannedExecutionGrouping';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';
import ExecutionCard from './ExecutionCard';
import ExecutionModal from './ExecutionModal';

const log = createLogger('frontend/components/PlannedExecutions');

type GroupMode = 'none' | 'folder' | 'trigger' | 'status';

/**
 * Planned Executions page: manage flows that run headlessly on triggers.
 */
const PlannedExecutionsManager = () => {
  const theme = useTheme();
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
      const message = result.error || 'Failed to update the planned execution.';
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
      const message = result.error || 'Failed to move the planned execution.';
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

  const filteredEntries = useMemo(() => {
    const filtered = entries.filter(entry =>
      matchesPlannedExecutionSearch(entry, searchTerm) &&
      matchesPlannedExecutionStatus(entry, statusFilter) &&
      (triggerFilter === 'all' || entry.execution.trigger.type === triggerFilter)
    );
    return sortPlannedExecutions(filtered, sortOption);
  }, [entries, searchTerm, statusFilter, triggerFilter, sortOption]);

  const groups = useMemo<CardGroup<PlannedExecutionListEntry>[]>(() => {
    if (groupMode === 'folder') {
      return groupByFolder(filteredEntries, entry => entry.execution.folder);
    }
    if (groupMode === 'trigger') {
      return groupItems(filteredEntries, plannedExecutionTriggerGroup);
    }
    if (groupMode === 'status') {
      return groupItems(filteredEntries, plannedExecutionStateGroup);
    }
    return [];
  }, [filteredEntries, groupMode]);

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

  const renderEntries = (items: PlannedExecutionListEntry[]) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto', width: '100%' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 2,
          mb: 1,
        }}
      >
        <Typography variant="h5">Planned Executions</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Tooltip title="Refresh">
            <IconButton onClick={() => void refresh()}>
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
            label={paused ? 'Paused' : 'Active'}
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
            Add execution
          </Button>
        </Box>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Run your flows automatically — on a schedule or when something happens —
        without opening the chat. FLUJO must be running for triggers to fire.
        The Active/Paused switch above gates <em>all</em> triggers globally.
      </Typography>

      {paused && entries.length > 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          The scheduler is paused — no triggers will fire, so every execution
          below shows “Paused (global)”. Switch it to Active (top right) to arm
          them.
        </Alert>
      )}

      {entries.length > 0 && (
        <>
          <Paper elevation={1} sx={{ mb: 1, p: 1 }}>
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
                placeholder="Search planned executions..."
                variant="outlined"
                size="small"
                fullWidth
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
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
                  <InputLabel id="execution-status-filter-label">Status</InputLabel>
                  <Select
                    labelId="execution-status-filter-label"
                    label="Status"
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as PlannedExecutionFilter)
                    }
                  >
                    <MenuItem value="all">All statuses</MenuItem>
                    <MenuItem value="enabled">Active</MenuItem>
                    <MenuItem value="disabled">Off</MenuItem>
                    <MenuItem value="running">Running</MenuItem>
                    <MenuItem value="attention">Needs attention</MenuItem>
                  </Select>
                </FormControl>

                <FormControl size="small" sx={{ minWidth: 140 }}>
                  <InputLabel id="execution-trigger-filter-label">Trigger</InputLabel>
                  <Select
                    labelId="execution-trigger-filter-label"
                    label="Trigger"
                    value={triggerFilter}
                    onChange={(event) =>
                      setTriggerFilter(event.target.value as 'all' | TriggerType)
                    }
                  >
                    <MenuItem value="all">All triggers</MenuItem>
                    {(Object.entries(TRIGGER_TYPE_LABELS) as Array<[TriggerType, string]>)
                      .map(([value, label]) => (
                        <MenuItem key={value} value={value}>{label}</MenuItem>
                      ))}
                  </Select>
                </FormControl>

                {hasActiveFilters && (
                  <Button size="small" onClick={clearFilters}>
                    Clear
                  </Button>
                )}

                <Tooltip title="Group cards">
                  <IconButton
                    size="small"
                    onClick={(event) => setGroupAnchorEl(event.currentTarget)}
                    color={groupMode !== 'none' ? 'primary' : 'default'}
                    sx={{
                      border: `1px solid ${theme.palette.divider}`,
                      backgroundColor: theme.palette.background.default,
                    }}
                  >
                    <LayersIcon fontSize="small" />
                  </IconButton>
                </Tooltip>

                <Tooltip title="Sort planned executions">
                  <IconButton
                    size="small"
                    onClick={(event) => setSortAnchorEl(event.currentTarget)}
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
              {filteredEntries.length} of {entries.length} planned execution
              {entries.length === 1 ? '' : 's'}
              {searchTerm && ` matching "${searchTerm}"`}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Sorted by: {PLANNED_EXECUTION_SORT_LABELS[sortOption]}
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
            Nothing planned yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Create your first planned execution to run a flow on a schedule.
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            New planned execution
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
          <Typography variant="h6" sx={{ mb: 1 }}>No matches</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Try a different search or filter.
          </Typography>
          <Button variant="outlined" onClick={clearFilters}>Clear filters</Button>
        </Box>
      )}

      {loaded && filteredEntries.length > 0 && (
        groupMode === 'none'
          ? renderEntries(filteredEntries)
          : groups.map(group => (
              <CollapsibleCardSection
                key={group.key}
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
          <ListItemText primary="No grouping" />
        </MenuItem>
        <MenuItem
          selected={groupMode === 'folder'}
          onClick={() => { setGroupMode('folder'); setGroupAnchorEl(null); }}
        >
          <ListItemIcon><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="By folder" />
        </MenuItem>
        <MenuItem
          selected={groupMode === 'trigger'}
          onClick={() => { setGroupMode('trigger'); setGroupAnchorEl(null); }}
        >
          <ListItemIcon><BoltOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="By trigger" />
        </MenuItem>
        <MenuItem
          selected={groupMode === 'status'}
          onClick={() => { setGroupMode('status'); setGroupAnchorEl(null); }}
        >
          <ListItemIcon><MonitorHeartOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="By status" />
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
          <ListItemText primary="Name (A-Z)" />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'name-desc'}
          onClick={() => { setSortOption('name-desc'); setSortAnchorEl(null); }}
        >
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary="Name (Z-A)" />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'newest'}
          onClick={() => { setSortOption('newest'); setSortAnchorEl(null); }}
        >
          <ListItemIcon><UpdateIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Newest first" />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'oldest'}
          onClick={() => { setSortOption('oldest'); setSortAnchorEl(null); }}
        >
          <ListItemIcon>
            <UpdateIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary="Oldest first" />
        </MenuItem>
        <MenuItem
          selected={sortOption === 'last-run'}
          onClick={() => { setSortOption('last-run'); setSortAnchorEl(null); }}
        >
          <ListItemIcon><MonitorHeartOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Most recently run" />
        </MenuItem>
      </Menu>

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
        <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This removes the planned execution and its run history. The flow
            itself is not affected.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PlannedExecutionsManager;
