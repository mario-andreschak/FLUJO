"use client";

import React, { useState, useEffect, useMemo } from 'react';
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
import FlowCard, { FlowCardSkeleton } from './FlowCard';
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
  isLoading?: boolean;
}

type SortOption = 'name-asc' | 'name-desc' | 'newest' | 'oldest' | 'most-nodes' | 'least-nodes';

const FlowDashboard = ({
  flows,
  selectedFlow,
  onSelectFlow,
  onDeleteFlow,
  onCopyFlow,
  onEditFlow,
  onCreateFlow,
  isLoading = false,
}: FlowDashboardProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('name-asc');
  const [viewMode, setViewMode] = useState<'grid' | 'compact'>('grid');
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  
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
  
  const handleSortChange = (option: SortOption) => {
    setSortOption(option);
    handleSortMenuClose();
  };
  
  // Handle search
  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
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
    
    // Then sort
    return [...result].sort((a, b) => {
      switch (sortOption) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'most-nodes':
          return b.nodes.length - a.nodes.length;
        case 'least-nodes':
          return a.nodes.length - b.nodes.length;
        // For newest/oldest, we would need timestamps on the Flow type
        // This is a placeholder using IDs which may not be timestamp-based
        case 'newest':
          return b.id.localeCompare(a.id);
        case 'oldest':
          return a.id.localeCompare(b.id);
        default:
          return 0;
      }
    });
  }, [flows, searchTerm, sortOption]);
  
  // Generate loading skeletons
  const renderSkeletons = () => {
    return Array(6).fill(0).map((_, index) => (
      <Grid item xs={12} sm={viewMode === 'compact' ? 12 : 6} md={viewMode === 'compact' ? 12 : 4} key={`skeleton-${index}`}>
        <FlowCardSkeleton />
      </Grid>
    ));
  };

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
            
            {/* New flow button */}
            {onCreateFlow && (
              <Button 
                variant="contained" 
                color="primary" 
                startIcon={<AddIcon />}
                onClick={onCreateFlow}
                size="small"
              >
                New Flow
              </Button>
            )}
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
          <Grid container spacing={2}>
            {filteredFlows.map(flow => (
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
                />
              </Grid>
            ))}
          </Grid>
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
