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
import FlowCard, { FlowCardSkeleton } from './FlowCard';
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';
import { groupByFolder, groupItems, collectFolders, CardGroup } from '@/utils/shared/cardGrouping';
import { FlowSortOption, deriveFlowSortGroup, sortFlows } from '@/utils/shared/flowGrouping';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
import { Flow } from '@/frontend/types/flow/flow';
import { createLogger } from '@/utils/logger';

const log = createLogger('components/Flow/FlowDashboard/FlowDashboard');

interface FlowDashboardProps {
  flows: Flow[];
  selectedFlow: string | null;
  onSelectFlow: (flowId: string) => void;
  onDeleteFlow: (flowId: string) => void;
  onCopyFlow?: (flowId: string) => void;
  onEditFlow?: (flowId: string) => void;
  onCreateFlow?: () => void;
  /** Assign/clear a flow's organizing folder (#71). */
  onSetFolder?: (flowId: string, folder: string | undefined) => void;
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
  onCreateFlow,
  onSetFolder,
  isLoading = false,
}: FlowDashboardProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  // Persisted view preferences (#93): survive navigating away and back. Search
  // is intentionally NOT persisted (session-scoped), and the transient menu
  // anchors stay ephemeral.
  const [sortOption, setSortOption] = useUiPreference<FlowSortOption>('flujo-ui:flows:sort', 'name-asc');
  const [viewMode, setViewMode] = useUiPreference<'grid' | 'compact'>('flujo-ui:flows:view', 'grid');
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [groupMode, setGroupMode] = useUiPreference<GroupMode>('flujo-ui:flows:group', 'none');
  const [groupAnchorEl, setGroupAnchorEl] = useState<null | HTMLElement>(null);
  // Keys of the sections the user has collapsed; everything defaults to expanded.
  // Persisted as a string[] and re-derived into a Set for O(1) lookups.
  const [collapsedList, setCollapsedList] = useUiPreference<string[]>('flujo-ui:flows:collapsed', []);
  const collapsedKeys = useMemo(() => new Set(collapsedList), [collapsedList]);

  // Context for the per-card consistency badge. Loaded once; flows are revalidated
  // whenever the list or the context changes. A failed load leaves a family undefined
  // so the validator skips those checks rather than mislabelling every card.
  const [validationContext, setValidationContext] = useState<{
    models?: Array<{ id: string; name?: string; displayName?: string }>;
    servers?: Array<{ name: string; status?: string }>;
  }>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ctx: { models?: any[]; servers?: Array<{ name: string; status?: string }> } = {};
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
      if (!cancelled) setValidationContext(ctx);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    
    // Then sort (shared helper — see utils/shared/flowGrouping.ts)
    return sortFlows(result, sortOption);
  }, [flows, searchTerm, sortOption]);

  // Distinct folders currently in use, for the "Move to folder" picker.
  const folders = useMemo(() => collectFolders(flows, (f) => f.folder), [flows]);

  // Grouped view of the filtered/sorted flows, driven by the active group mode.
  const groups = useMemo<CardGroup<Flow>[]>(() => {
    if (groupMode === 'folder') {
      return groupByFolder(filteredFlows, (f) => f.folder);
    }
    if (groupMode === 'sort') {
      return groupItems(filteredFlows, (f) => deriveFlowSortGroup(f, sortOption));
    }
    return [];
  }, [groupMode, filteredFlows, sortOption]);
  
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
    <Grid container spacing={2}>
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
            selected={selectedFlow === flow.id}
            onSelect={onSelectFlow}
            onDelete={onDeleteFlow}
            onCopy={onCopyFlow}
            onEdit={onEditFlow}
            onSetFolder={onSetFolder}
            folders={folders}
            validation={validationByFlow[flow.id]}
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
            placeholder="Search flows..."
            variant="outlined"
            size="small"
            fullWidth
            value={searchTerm}
            onChange={handleSearchChange}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ maxWidth: { sm: 300 } }}
          />
          
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            {/* View mode toggle */}
            <Box sx={{ 
              display: 'flex', 
              backgroundColor: theme.palette.background.default,
              borderRadius: 1,
              border: `1px solid ${theme.palette.divider}`,
              overflow: 'hidden'
            }}>
              <IconButton 
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
              title="Group cards"
            >
              <LayersIcon fontSize="small" />
            </IconButton>
            
            {/* Sort button */}
            <IconButton
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
          {filteredFlows.length} of {flows.length} flows
          {searchTerm && ` matching "${searchTerm}"`}
        </Typography>
        
        <Typography variant="body2" color="textSecondary">
          Sorted by: {
            sortOption === 'name-asc' ? 'Name (A-Z)' :
            sortOption === 'name-desc' ? 'Name (Z-A)' :
            sortOption === 'newest' ? 'Newest first' :
            sortOption === 'oldest' ? 'Oldest first' :
            sortOption === 'most-nodes' ? 'Most nodes' :
            'Least nodes'
          }
        </Typography>
      </Box>
      
      {/* Main content - Flow cards in grid */}
      <Box sx={{ 
        flex: 1, 
        overflow: 'auto',
        px: 1,
        pb: 2
      }}>
        {isLoading ? (
          <Grid container spacing={2}>
            {renderSkeletons()}
          </Grid>
        ) : filteredFlows.length > 0 ? (
          groupMode === 'none' ? (
            renderFlowGrid(filteredFlows)
          ) : (
            groups.map((group) => (
              <CollapsibleCardSection
                key={group.key}
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
              No flows found
            </Typography>
            {searchTerm ? (
              <Typography variant="body2" color="textSecondary" align="center">
                No flows match your search criteria.
                <Box component="span" display="block" mt={1}>
                  Try a different search term or <Button size="small" onClick={() => setSearchTerm('')}>clear the search</Button>
                </Box>
              </Typography>
            ) : (
              <Typography variant="body2" color="textSecondary" align="center">
                Get started by creating your first flow.
                {onCreateFlow && (
                  <Box component="span" display="block" mt={2}>
                    <Button 
                      variant="contained" 
                      color="primary" 
                      startIcon={<AddIcon />}
                      onClick={onCreateFlow}
                    >
                      Create New Flow
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
          <ListItemText primary="No grouping" />
        </MenuItem>
        <MenuItem selected={groupMode === 'folder'} onClick={() => handleGroupChange('folder')}>
          <ListItemIcon>
            <FolderOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="By folder" />
        </MenuItem>
        <MenuItem selected={groupMode === 'sort'} onClick={() => handleGroupChange('sort')}>
          <ListItemIcon>
            <LayersIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="By sort setting" />
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
          <ListItemText primary="Name (A-Z)" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('name-desc')}>
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary="Name (Z-A)" />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('newest')}>
          <ListItemIcon>
            <UpdateIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Newest first" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('oldest')}>
          <ListItemIcon>
            <UpdateIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary="Oldest first" />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('most-nodes')}>
          <ListItemIcon>
            <FilterListIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Most nodes" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('least-nodes')}>
          <ListItemIcon>
            <FilterListIcon fontSize="small" sx={{ transform: 'scaleY(-1)' }} />
          </ListItemIcon>
          <ListItemText primary="Least nodes" />
        </MenuItem>
      </Menu>
    </Box>
  );
};

export default FlowDashboard;

// Helper function to create alpha version of a color
function alpha(color: string, value: number) {
  return color + Math.round(value * 255).toString(16).padStart(2, '0');
}
