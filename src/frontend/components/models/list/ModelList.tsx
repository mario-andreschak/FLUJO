"use client";

import React, { useMemo, useState } from 'react';
import {
  Grid,
  CircularProgress,
  Box,
  Paper,
  Typography,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  useTheme,
} from '@mui/material';
import SortIcon from '@mui/icons-material/Sort';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import CategoryIcon from '@mui/icons-material/Category';
import MemoryIcon from '@mui/icons-material/Memory';
import LayersIcon from '@mui/icons-material/Layers';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ModelCard from './ModelCard';
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';
import { groupByFolder, groupItems, CardGroup } from '@/utils/shared/cardGrouping';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
import {
  ModelSortOption,
  MODEL_SORT_LABELS,
  deriveModelSortGroup,
  sortModels,
} from '@/utils/shared/modelGrouping';
import { Model } from '@/shared/types';
import { ModelResult } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/models/list/ModelList');

interface ModelListProps {
  models: Model[];
  isLoading: boolean;
  onAdd: () => void;
  onUpdate: (model: Model) => Promise<ModelResult>;
  onDelete: (id: string) => Promise<void>;
  /** Existing folders on the Models surface, for the "Move to folder…" picker. */
  folders?: string[];
  /** Assign/clear a model's organizing folder (#80). When omitted the action is hidden. */
  onSetFolder?: (modelId: string, folder: string | undefined) => void;
}

/** How cards are grouped into collapsible sections: none, by user folder, or by the active sort key. */
type GroupMode = 'none' | 'folder' | 'sort';

export const ModelList = ({ models, isLoading, onAdd, onUpdate, onDelete, folders = [], onSetFolder }: ModelListProps) => {
    const theme = useTheme();
    // Persisted view preferences (#93): retained across navigation.
    const [sortOption, setSortOption] = useUiPreference<ModelSortOption>('flujo-ui:models:sort', 'name-asc');
    const [groupMode, setGroupMode] = useUiPreference<GroupMode>('flujo-ui:models:group', 'none');
    const [sortAnchorEl, setSortAnchorEl] = useState<null | HTMLElement>(null);
    const [groupAnchorEl, setGroupAnchorEl] = useState<null | HTMLElement>(null);
    // Keys of the sections the user has collapsed; everything defaults to expanded.
    // Persisted as a string[] and re-derived into a Set for O(1) lookups.
    const [collapsedList, setCollapsedList] = useUiPreference<string[]>('flujo-ui:models:collapsed', []);
    const collapsedKeys = useMemo(() => new Set(collapsedList), [collapsedList]);

    const handleSortChange = (option: ModelSortOption) => {
        setSortOption(option);
        setSortAnchorEl(null);
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

    const handleUpdate = async (model: Model): Promise<void> => {
        const result = await onUpdate(model);
        if (!result.success) {
          log.error('Failed to update model in ModelList', result.error);
        }
    };

    // Sort the incoming (already search-filtered) models by the active sort key.
    const sortedModels = useMemo(() => sortModels(models, sortOption), [models, sortOption]);

    // Grouped view of the sorted models, driven by the active group mode.
    const groups = useMemo<CardGroup<Model>[]>(() => {
        if (groupMode === 'folder') {
            return groupByFolder(sortedModels, (m) => m.folder);
        }
        if (groupMode === 'sort') {
            return groupItems(sortedModels, (m) => deriveModelSortGroup(m, sortOption));
        }
        return [];
    }, [groupMode, sortedModels, sortOption]);

    if (isLoading) {
        return (
            <Box display="flex" justifyContent="center" py={4}>
                <CircularProgress />
            </Box>
        );
    }

    // Render a grid of model cards for a given subset (whole list or one group).
    const renderModelGrid = (items: Model[]) => (
        <Grid container spacing={2}>
            {items.map((model) => (
                <Grid item xs={12} sm={6} md={4} key={model.id}>
                    <ModelCard
                        model={model}
                        onEdit={() => handleUpdate(model)}
                        onDelete={() => onDelete(model.id)}
                        folder={model.folder}
                        folders={folders}
                        onSetFolder={onSetFolder ? (folder) => onSetFolder(model.id, folder) : undefined}
                    />
                </Grid>
            ))}
        </Grid>
    );

    return (
        <Box>
            {/* Sort + group toolbar, mirroring the Flow dashboard */}
            <Paper elevation={1} sx={{ mb: 2, p: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Typography variant="body2" color="textSecondary">
                        {models.length} model{models.length === 1 ? '' : 's'}
                        <Box component="span" sx={{ mx: 1, opacity: 0.5 }}>·</Box>
                        Sorted by: {MODEL_SORT_LABELS[sortOption]}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                        <IconButton
                            size="small"
                            onClick={(e) => setGroupAnchorEl(e.currentTarget)}
                            color={groupMode !== 'none' ? 'primary' : 'default'}
                            sx={{ border: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.default }}
                            title="Group cards"
                        >
                            <LayersIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                            size="small"
                            onClick={(e) => setSortAnchorEl(e.currentTarget)}
                            sx={{ border: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.default }}
                            title="Sort models"
                        >
                            <SortIcon fontSize="small" />
                        </IconButton>
                    </Box>
                </Box>
            </Paper>

            {!models || models.length === 0 ? (
                <Box textAlign="center" py={4}>
                    No models found
                </Box>
            ) : groupMode === 'none' ? (
                renderModelGrid(sortedModels)
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
                        {renderModelGrid(group.items)}
                    </CollapsibleCardSection>
                ))
            )}

            {/* Group-by menu */}
            <Menu
                anchorEl={groupAnchorEl}
                open={Boolean(groupAnchorEl)}
                onClose={() => setGroupAnchorEl(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
                <MenuItem selected={groupMode === 'none'} onClick={() => handleGroupChange('none')}>
                    <ListItemIcon><LayersClearIcon fontSize="small" /></ListItemIcon>
                    <ListItemText primary="No grouping" />
                </MenuItem>
                <MenuItem selected={groupMode === 'folder'} onClick={() => handleGroupChange('folder')}>
                    <ListItemIcon><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
                    <ListItemText primary="By folder" />
                </MenuItem>
                <MenuItem selected={groupMode === 'sort'} onClick={() => handleGroupChange('sort')}>
                    <ListItemIcon><LayersIcon fontSize="small" /></ListItemIcon>
                    <ListItemText primary="By sort setting" />
                </MenuItem>
            </Menu>

            {/* Sort menu */}
            <Menu
                anchorEl={sortAnchorEl}
                open={Boolean(sortAnchorEl)}
                onClose={() => setSortAnchorEl(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
                <MenuItem selected={sortOption === 'name-asc'} onClick={() => handleSortChange('name-asc')}>
                    <ListItemIcon><SortByAlphaIcon fontSize="small" /></ListItemIcon>
                    <ListItemText primary="Name (A-Z)" />
                </MenuItem>
                <MenuItem selected={sortOption === 'name-desc'} onClick={() => handleSortChange('name-desc')}>
                    <ListItemIcon><SortByAlphaIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} /></ListItemIcon>
                    <ListItemText primary="Name (Z-A)" />
                </MenuItem>
                <Divider />
                <MenuItem selected={sortOption === 'provider'} onClick={() => handleSortChange('provider')}>
                    <ListItemIcon><CategoryIcon fontSize="small" /></ListItemIcon>
                    <ListItemText primary="Provider" />
                </MenuItem>
                <Divider />
                <MenuItem selected={sortOption === 'context-desc'} onClick={() => handleSortChange('context-desc')}>
                    <ListItemIcon><MemoryIcon fontSize="small" /></ListItemIcon>
                    <ListItemText primary="Context (largest)" />
                </MenuItem>
                <MenuItem selected={sortOption === 'context-asc'} onClick={() => handleSortChange('context-asc')}>
                    <ListItemIcon><MemoryIcon fontSize="small" sx={{ transform: 'scaleY(-1)' }} /></ListItemIcon>
                    <ListItemText primary="Context (smallest)" />
                </MenuItem>
            </Menu>
        </Box>
    );
};

export default ModelList;
