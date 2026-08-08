"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { validateFlow, FlowValidationResult } from '@/utils/shared/flowValidation';
import { 
  Box, 
  Grid, 
  TextField, 
  InputAdornment, 
  Typography, 
  Fade,
  Divider,
  Paper,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Button,
  useTheme,
  useMediaQuery
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import SortIcon from '@mui/icons-material/Sort';
import FilterListIcon from '@mui/icons-material/FilterList';
import ViewListIcon from '@mui/icons-material/ViewList';
import ViewModuleIcon from '@mui/icons-material/ViewModule';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import UpdateIcon from '@mui/icons-material/Update';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import AddIcon from '@mui/icons-material/Add';
import LayersIcon from '@mui/icons-material/Layers';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import FlowCard, { FlowCardSkeleton } from './FlowCard';
import QuickChangeModelsDialog, { type QuickModelChangeResult } from './QuickChangeModelsDialog';
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';
import {
  groupByFolder,
  groupItems,
  collectFolders,
  CardGroup,
  DEFAULT_CARD_GROUP_MODE,
} from '@/utils/shared/cardGrouping';
import { FlowSortOption, deriveFlowSortGroup, sortFlowsFavoritesFirst } from '@/utils/shared/flowGrouping';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
import { useAutoFocusSearch } from '@/frontend/hooks/useAutoFocusSearch';
import { useScrollRestoration } from '@/frontend/hooks/useScrollRestoration';
import ScrollControlsStack from '@/frontend/components/shared/ScrollControlsStack';
import { useGroupScrollNavigation } from '@/frontend/hooks/useGroupScrollNavigation';
import { Flow } from '@/frontend/types/flow/flow';
import type { Model } from '@/shared/types/model';
import type { FlowModelReplacementMap } from '@/utils/shared/flowModelReplacement';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';

const log = createLogger('components/Flow/FlowDashboard/FlowDashboard');

interface FlowDashboardProps {
  flows: Flow[];
  selectedFlow: string | null;
  onSelectFlow: (flowId: string) => void;
  onDeleteFlow: (flowId: string) => void;
  onCopyFlow?: (flowId: string) => void;
  onEditFlow?: (flowId: string) => void;
  /** Start a new chat conversation bound to a flow (#148). */
  onOpenInChat?: (flowId: string) => void;
  onCreateFlow?: () => void;
  /** Assign/clear a flow's organizing folder (#71). */
  onSetFolder?: (flowId: string, folder: string | undefined) => void;
  /** Toggle a flow's favorite flag (#120). */
  onToggleFavorite?: (flowId: string) => void;
  /** Persist model-id substitutions across several selected flows (#401). */
  onReplaceModels?: (
    flowIds: string[],
    replacements: FlowModelReplacementMap,
  ) => Promise<QuickModelChangeResult>;
  isLoading?: boolean;
}

/** How cards are grouped into collapsible sections: not at all, by user folder (#71), or by the active sort key (#73). */
type GroupMode = 'none' | 'folder' | 'sort';

const FlowDashboard = ({
  flows,
  selectedFlow,
  onSelectFlow,
  onDeleteFlow,
  onCopyFlow,
  onEditFlow,
  onOpenInChat,
  onCreateFlow,
  onSetFolder,
  onToggleFavorite,
  onReplaceModels,
  isLoading = false,
}: FlowDashboardProps) => {
  const { t, tp, formatNumber } = useI18n();
  const [searchTerm, setSearchTerm] = useState('');
  // #372: place the caret in the search field automatically. The toolbar Paper
  // already sits outside the inner scroll container below, so it stays visible
  // without a sticky wrapper — only auto-focus is needed here.
  const searchInputRef = useAutoFocusSearch();
  // Persisted view preferences (#93): survive navigating away and back. Search
  // is intentionally NOT persisted (session-scoped), and the transient menu
  // anchors stay ephemeral.
  const [sortOption, setSortOption] = useUiPreference<FlowSortOption>('flujo-ui:flows:sort', 'name-asc');
  const [viewMode, setViewMode] = useUiPreference<'grid' | 'compact'>('flujo-ui:flows:view', 'grid');
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [groupMode, setGroupMode] = useUiPreference<GroupMode>('flujo-ui:flows:group', DEFAULT_CARD_GROUP_MODE);
  const [groupAnchorEl, setGroupAnchorEl] = useState<null | HTMLElement>(null);
  const [modelSelectionMode, setModelSelectionMode] = useState(false);
  const [selectedForModelChange, setSelectedForModelChange] = useState<Set<string>>(new Set());
  const [quickChangeOpen, setQuickChangeOpen] = useState(false);
  // Keys of the sections the user has collapsed; everything defaults to expanded.
  // Persisted as a string[] and re-derived into a Set for O(1) lookups.
  const [collapsedList, setCollapsedList] = useUiPreference<string[]>('flujo-ui:flows:collapsed', []);
  const collapsedKeys = useMemo(() => new Set(collapsedList), [collapsedList]);

  // Context for the per-card consistency badge. Loaded once; flows are revalidated
  // whenever the list or the context changes. A failed load leaves a family undefined
  // so the validator skips those checks rather than mislabelling every card.
  const [validationContext, setValidationContext] = useState<{
    models?: Model[];
    servers?: Array<{ name: string; status?: string }>;
  }>({});
  const [modelsLoading, setModelsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ctx: { models?: Model[]; servers?: Array<{ name: string; status?: string }> } = {};
      try {
        const res = await fetch('/api/model');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) ctx.models = data;
        }
      } catch (error) {
        log.warn('Could not load models for flow badges', error);
      }
      try {
        const res = await fetch('/api/mcp/servers');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            ctx.servers = data.map((s: any) => ({ name: s.name, status: s.disabled ? 'disabled' : undefined }));
          }
        }
      } catch (error) {
        log.warn('Could not load servers for flow badges', error);
      }
      if (!cancelled) {
        setValidationContext(ctx);
        setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const availableIds = new Set(flows.map((flow) => flow.id));
    setSelectedForModelChange((current) => {
      const next = new Set(Array.from(current).filter((id) => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [flows]);

  const validationByFlow = useMemo(() => {
    const map: Record<string, FlowValidationResult> = {};
    for (const flow of flows) {
      try {
        map[flow.id] = validateFlow(flow as any, validationContext);
      } catch (error) {
        log.warn('Failed to validate flow for badge', { flowId: flow.id, error });
      }
    }
    return map;
  }, [flows, validationContext]);
  
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.down('md'));
  
  // Determine columns based on screen size and view mode
  const getGridColumns = () => {
    if (viewMode === 'compact') return 1;
    if (isMobile) return 1;
    if (isTablet) return 2;
    return 3;
  };
  
  // Sort menu
  const handleSortMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };
  
  const handleSortMenuClose = () => {
    setAnchorEl(null);
  };
  
  const handleSortChange = (option: FlowSortOption) => {
    setSortOption(option);
    handleSortMenuClose();
  };
  
  // Handle search
  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  };

  const handleGroupChange = (mode: GroupMode) => {
    setGroupMode(mode);
    setGroupAnchorEl(null);
  };

  const toggleCollapsed = (key: string) => {
    setCollapsedList((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const toggleModelSelection = (flowId: string) => {
    setSelectedForModelChange((current) => {
      const next = new Set(current);
      if (next.has(flowId)) next.delete(flowId);
      else next.add(flowId);
      return next;
    });
  };

  const leaveModelSelectionMode = () => {
    setModelSelectionMode(false);
    setSelectedForModelChange(new Set());
    setQuickChangeOpen(false);
  };
  
  // Filter and sort flows
  const filteredFlows = useMemo(() => {
    log.debug('Filtering and sorting flows', { searchTerm, sortOption });
    
    // First filter by search term
    let result = flows;
    
    if (searchTerm.trim() !== '') {
      const lowerCaseSearch = searchTerm.toLowerCase();
      result = flows.filter(flow => 
        flow.name.toLowerCase().includes(lowerCaseSearch)
      );
    }
    
    // Then sort favorites-first, then by the active key (shared helper — see
    // utils/shared/flowGrouping.ts). Favorites (#120) float to the top.
    return sortFlowsFavoritesFirst(result, sortOption);
  }, [flows, searchTerm, sortOption]);

  // Persist scroll position + back-to-top (#185); re-restore once the cards load.
  const { ref: scrollRef, showBackToTop, scrollToTop } = useScrollRestoration<HTMLDivElement>(
    'flujo-ui:scroll:flows',
    { deps: [isLoading, filteredFlows.length] },
  );

  const { scrollToPreviousGroup, scrollToNextGroup } = useGroupScrollNavigation(scrollRef);
  const scrollToBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });

  // Distinct folders currently in use, for the "Move to folder" picker.
  const folders = useMemo(() => collectFolders(flows, (f) => f.folder), [flows]);

  // Grouped view of the filtered/sorted flows, driven by the active group mode.
  const groups = useMemo<CardGroup<Flow>[]>(() => {
    if (groupMode === 'folder') {
      return groupByFolder(filteredFlows, (f) => f.folder, t('flows.group.ungrouped'));
    }
    if (groupMode === 'sort') {
      return groupItems(filteredFlows, (f) => {
        const group = deriveFlowSortGroup(f, sortOption);
        const labels: Record<string, string> = {
          'recency:unknown': t('flows.group.noDate'),
          'recency:today': t('flows.group.today'),
          'recency:week': t('flows.group.week'),
          'recency:month': t('flows.group.month'),
          'recency:older': t('flows.group.older'),
          'nodes:0': t('flows.group.nodes0'),
          'nodes:1-2': t('flows.group.nodes12'),
          'nodes:3-5': t('flows.group.nodes35'),
          'nodes:6-10': t('flows.group.nodes610'),
          'nodes:11+': t('flows.group.nodes11'),
          all: t('flows.group.all'),
        };
        return { ...group, label: labels[group.key] ?? group.label };
      });
    }
    return [];
  }, [groupMode, filteredFlows, sortOption, t]);

  const sortLabel =
    sortOption === 'name-asc' ? t('flows.sort.nameAsc') :
    sortOption === 'name-desc' ? t('flows.sort.nameDesc') :
    sortOption === 'newest' ? t('flows.sort.newest') :
    sortOption === 'oldest' ? t('flows.sort.oldest') :
    sortOption === 'most-nodes' ? t('flows.sort.mostSteps') :
    t('flows.sort.fewestSteps');
  
  // Generate loading skeletons
  const renderSkeletons = () => {
    return Array(6).fill(0).map((_, index) => (
      <Grid item xs={12} sm={viewMode === 'compact' ? 12 : 6} md={viewMode === 'compact' ? 12 : 4} key={`skeleton-${index}`}>
        <FlowCardSkeleton />
      </Grid>
    ));
  };

  // Render a grid of flow cards for a given subset (whole list or one group).
  const renderFlowGrid = (items: Flow[]) => (
    <Grid container spacing={2.5}>
      {items.map(flow => (
        <Grid 
          item 
          xs={12} 
          sm={viewMode === 'compact' ? 12 : 6} 
          md={viewMode === 'compact' ? 12 : getGridColumns() === 3 ? 4 : 6} 
          key={flow.id}
        >
          <FlowCard
            flow={flow}
            selected={modelSelectionMode ? selectedForModelChange.has(flow.id) : selectedFlow === flow.id}
            onSelect={modelSelectionMode ? toggleModelSelection : onSelectFlow}
            onDelete={onDeleteFlow}
            onCopy={onCopyFlow}
            onEdit={onEditFlow}
            onOpenInChat={onOpenInChat}
            onSetFolder={onSetFolder}
            onToggleFavorite={onToggleFavorite}
            folders={folders}
            validation={validationByFlow[flow.id]}
            selectionMode={modelSelectionMode}
          />
        </Grid>
      ))}
    </Grid>
  );

  return (
    <Box sx={{ 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Toolbar with search and actions */}
      <Paper elevation={1} sx={{ mb: 2, p: 1 }}>
        <Box sx={{ 
          display: 'flex', 
          flexDirection: { xs: 'column', sm: 'row' }, 
          gap: 1,
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between'
        }}>
          {/* Search field */}
          <TextField
            placeholder={t('flows.dashboard.search')}
            variant="outlined"
            size="small"
            fullWidth
            value={searchTerm}
            onChange={handleSearchChange}
            inputRef={searchInputRef}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ maxWidth: { sm: 300 } }}
          />
          
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            {onReplaceModels && (
              modelSelectionMode ? (
                <>
                  <Button
                    size="small"
                    onClick={() => setSelectedForModelChange(new Set(filteredFlows.map((flow) => flow.id)))}
                  >
                    {t('flows.quickModels.selectVisible')}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => setSelectedForModelChange(new Set())}
                    disabled={selectedForModelChange.size === 0}
                  >
                    {t('flows.quickModels.clear')}
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SwapHorizRoundedIcon />}
                    disabled={selectedForModelChange.size === 0}
                    onClick={() => setQuickChangeOpen(true)}
                  >
                    {t('flows.quickModels.changeSelected', {
                      count: formatNumber(selectedForModelChange.size),
                    })}
                  </Button>
                  <IconButton
                    size="small"
                    aria-label={t('flows.quickModels.cancelSelection')}
                    onClick={leaveModelSelectionMode}
                  >
                    <CloseRoundedIcon fontSize="small" />
                  </IconButton>
                </>
              ) : (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<SwapHorizRoundedIcon />}
                  disabled={flows.length === 0 || isLoading}
                  onClick={() => setModelSelectionMode(true)}
                >
                  {t('flows.quickModels.start')}
                </Button>
              )
            )}
            {/* View mode toggle */}
            <Box sx={{ 
              display: 'flex', 
              backgroundColor: theme.palette.background.default,
              borderRadius: 1,
              border: `1px solid ${theme.palette.divider}`,
              overflow: 'hidden'
            }}>
              <IconButton 
                aria-label={t('flows.dashboard.cards')}
                size="small" 
                onClick={() => setViewMode('grid')}
                color={viewMode === 'grid' ? 'primary' : 'default'}
                sx={{ 
                  borderRadius: 0,
                  backgroundColor: viewMode === 'grid' ? 
                    alpha(theme.palette.primary.main, 0.1) : 'transparent'
                }}
              >
                <ViewModuleIcon fontSize="small" />
              </IconButton>
              <IconButton 
                aria-label={t('flows.dashboard.compact')}
                size="small" 
                onClick={() => setViewMode('compact')}
                color={viewMode === 'compact' ? 'primary' : 'default'}
                sx={{ 
                  borderRadius: 0,
                  backgroundColor: viewMode === 'compact' ? 
                    alpha(theme.palette.primary.main, 0.1) : 'transparent'
                }}
              >
                <ViewListIcon fontSize="small" />
              </IconButton>
            </Box>

            {/* Group-by button (#71 folders / #73 sort-fold) */}
            <IconButton
              size="small"
              onClick={(e) => setGroupAnchorEl(e.currentTarget)}
              color={groupMode !== 'none' ? 'primary' : 'default'}
              sx={{
                border: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.background.default
              }}
              title={t('flows.dashboard.groupCards')}
              aria-label={t('flows.dashboard.groupAgents')}
            >
              <LayersIcon fontSize="small" />
            </IconButton>
            
            {/* Sort button */}
            <IconButton
              aria-label={t('flows.dashboard.sortAgents')}
              size="small"
              onClick={handleSortMenuOpen}
              sx={{
                border: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.background.default
              }}
            >
              <SortIcon fontSize="small" />
            </IconButton>
            {/* "New Flow" lives in the page header (and the empty-state CTA below);
                a third button here was redundant, so it was removed. */}
          </Box>
        </Box>
      </Paper>
      
      {/* Statistics bar */}
      <Box sx={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        mb: 2,
        px: 1
      }}>
        <Typography variant="body2" color="textSecondary">
          {tp('flows.dashboard.count', flows.length, {
            shown: formatNumber(filteredFlows.length),
            total: formatNumber(flows.length),
          })}
          {searchTerm && t('flows.dashboard.matching', { search: searchTerm })}
        </Typography>
        
        <Typography variant="body2" color="textSecondary">
          {t('flows.dashboard.showing', { sort: sortLabel })}
        </Typography>
      </Box>
      
      {/* Main content - Flow cards in grid */}
      <Box ref={scrollRef} sx={{ 
        flex: 1, 
        overflow: 'auto',
        px: 1,
        pb: 2
      }}>
        {isLoading ? (
          <Grid container spacing={2.5}>
            {renderSkeletons()}
          </Grid>
        ) : filteredFlows.length > 0 ? (
          groupMode === 'none' ? (
            renderFlowGrid(filteredFlows)
          ) : (
            groups.map((group) => (
              <CollapsibleCardSection
                key={group.key}
                groupKey={group.key}
                label={group.label}
                count={group.items.length}
                expanded={!collapsedKeys.has(group.key)}
                onToggle={() => toggleCollapsed(group.key)}
                showFolderIcon={groupMode === 'folder'}
              >
                {renderFlowGrid(group.items)}
              </CollapsibleCardSection>
            ))
          )
        ) : (
          <Box sx={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center',
            p: 4,
            backgroundColor: theme.palette.background.paper,
            borderRadius: 1,
            border: `1px dashed ${theme.palette.divider}`,
            height: '100%',
            minHeight: 200
          }}>
            <Typography variant="h6" gutterBottom color="textSecondary">
              {searchTerm ? t('flows.dashboard.noMatches') : t('flows.dashboard.empty')}
            </Typography>
            {searchTerm ? (
              <Typography variant="body2" color="textSecondary" align="center">
                {t('flows.dashboard.noMatchHelp')}
                <Box component="span" display="block" mt={1}>
                  <Trans
                    message="flows.dashboard.trySearch"
                    values={{ clearAction: <Button size="small" onClick={() => setSearchTerm('')}>{t('flows.dashboard.clearSearch')}</Button> }}
                  />
                </Box>
              </Typography>
            ) : (
              <Typography variant="body2" color="textSecondary" align="center">
                {t('flows.dashboard.emptyHelp')}
                {onCreateFlow && (
                  <Box component="span" display="block" mt={2}>
                    <Button 
                      variant="contained" 
                      color="primary" 
                      startIcon={<AddIcon />}
                      onClick={onCreateFlow}
                    >
                      {t('flows.dashboard.createFirst')}
                    </Button>
                  </Box>
                )}
              </Typography>
            )}
          </Box>
        )}
      </Box>

      {/* Group-by menu */}
      <Menu
        anchorEl={groupAnchorEl}
        open={Boolean(groupAnchorEl)}
        onClose={() => setGroupAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem selected={groupMode === 'none'} onClick={() => handleGroupChange('none')}>
          <ListItemIcon>
            <LayersClearIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('flows.group.none')} />
        </MenuItem>
        <MenuItem selected={groupMode === 'folder'} onClick={() => handleGroupChange('folder')}>
          <ListItemIcon>
            <FolderOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('flows.group.folder')} />
        </MenuItem>
        <MenuItem selected={groupMode === 'sort'} onClick={() => handleGroupChange('sort')}>
          <ListItemIcon>
            <LayersIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('flows.group.sort')} />
        </MenuItem>
      </Menu>
      
      {/* Sort menu */}
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleSortMenuClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
      >
        <MenuItem onClick={() => handleSortChange('name-asc')}>
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('flows.sort.nameAsc')} />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('name-desc')}>
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary={t('flows.sort.nameDesc')} />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('newest')}>
          <ListItemIcon>
            <UpdateIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('flows.sort.newest')} />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('oldest')}>
          <ListItemIcon>
            <UpdateIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary={t('flows.sort.oldest')} />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('most-nodes')}>
          <ListItemIcon>
            <FilterListIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('flows.sort.mostSteps')} />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('least-nodes')}>
          <ListItemIcon>
            <FilterListIcon fontSize="small" sx={{ transform: 'scaleY(-1)' }} />
          </ListItemIcon>
          <ListItemText primary={t('flows.sort.fewestSteps')} />
        </MenuItem>
      </Menu>

      <ScrollControlsStack
        show={showBackToTop}
        onTop={scrollToTop}
        onPrevious={scrollToPreviousGroup}
        onNext={scrollToNextGroup}
        onBottom={scrollToBottom}
        labels={{ top: t('backToTop.action'), previous: t('scrollControls.previousGroup'), next: t('scrollControls.nextGroup'), bottom: t('scrollControls.bottom') }}
      />

      {onReplaceModels && (
        <QuickChangeModelsDialog
          open={quickChangeOpen}
          flows={flows.filter((flow) => selectedForModelChange.has(flow.id))}
          models={validationContext.models ?? []}
          modelsLoading={modelsLoading}
          onClose={() => setQuickChangeOpen(false)}
          onApply={async (replacements) => {
            const result = await onReplaceModels(Array.from(selectedForModelChange), replacements);
            if (result.updatedFlowCount > 0 || result.failedFlowCount === 0) {
              setModelSelectionMode(false);
              setSelectedForModelChange(new Set());
            }
            return result;
          }}
        />
      )}
    </Box>
  );
};

export default FlowDashboard;

// Helper function to create alpha version of a color
function alpha(color: string, value: number) {
  return color + Math.round(value * 255).toString(16).padStart(2, '0');
}
