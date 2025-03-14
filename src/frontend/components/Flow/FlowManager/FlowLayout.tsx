"use client";

import React, { useState, useEffect } from 'react';
import { Box, Button, Divider, Typography, styled, Fade, Slide } from '@mui/material';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import FlowList from './FlowBuilder/FlowList';
import { Flow } from '@/frontend/types/flow/flow';
import { createLogger } from '@/utils/logger';

const log = createLogger('components/Flow/FlowManager/FlowLayout');

interface FlowLayoutProps {
  flows: Flow[];
  selectedFlow: string | null;
  onSelectFlow: (flowId: string | null) => void;
  onDeleteFlow: (flowId: string) => void;
  onCopyFlow?: (flowId: string) => void;
  isLoading?: boolean;
  children: React.ReactNode;
}

// Styled components for animations
const ListContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'isVisible' && prop !== 'isCollapsed',
})<{ isVisible: boolean; isCollapsed: boolean }>(({ theme, isVisible, isCollapsed }) => ({
  transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
  maxHeight: isCollapsed ? '0' : '350px',
  opacity: isVisible ? 1 : 0,
  overflow: 'hidden',
  position: 'relative',
  zIndex: 10,
  backgroundColor: theme.palette.background.paper,
  borderBottom: isVisible && !isCollapsed ? `1px solid ${theme.palette.divider}` : 'none',
  boxShadow: isVisible && !isCollapsed ? theme.shadows[1] : 'none',
}));

const ToggleButton = styled(Button)(({ theme }) => ({
  position: 'absolute',
  right: '20px',
  zIndex: 20,
  minWidth: '120px',
  borderRadius: '0 0 8px 8px',
  boxShadow: theme.shadows[2],
  backgroundColor: theme.palette.primary.main,
  color: theme.palette.primary.contrastText,
  '&:hover': {
    backgroundColor: theme.palette.primary.dark,
  },
  transition: 'top 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
}));

const ContentContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'fullscreen',
})<{ fullscreen: boolean }>(({ fullscreen }) => ({
  flex: 1,
  transition: 'height 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
  height: fullscreen ? 'calc(100vh - 64px)' : 'calc(100vh - 64px - 350px)',
  overflow: 'auto',
}));

export const FlowLayout = ({
  flows,
  selectedFlow,
  onSelectFlow,
  onDeleteFlow,
  onCopyFlow,
  isLoading = false,
  children,
}: FlowLayoutProps) => {
  // State to control the visibility of the FlowList
  const [isListVisible, setIsListVisible] = useState(true);
  
  // State to track if the list is fully collapsed (for animation purposes)
  const [isListCollapsed, setIsListCollapsed] = useState(false);
  
  // When a flow is selected, don't automatically collapse the list anymore
  // Let the user decide when to show/hide
  useEffect(() => {
    // If no flow is selected, always show the list
    if (!selectedFlow) {
      setIsListVisible(true);
      setIsListCollapsed(false);
    }
    // Otherwise maintain current state
  }, [selectedFlow]);
  
  // Handle the animation timing for collapsing with improved timing
  useEffect(() => {
    let timer: NodeJS.Timeout;
    
    if (!isListVisible) {
      log.debug('Collapsing flow list');
      // When hiding, wait a bit longer before collapse to make animation smoother
      timer = setTimeout(() => {
        setIsListCollapsed(true);
      }, 300);
    } else {
      log.debug('Expanding flow list');
      // When showing, immediately uncollapse to start the height animation
      setIsListCollapsed(false);
    }
    
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isListVisible]);
  
  // Toggle the list visibility
  const toggleList = () => {
    setIsListVisible(prev => !prev);
    log.debug('Toggle list visibility', { newState: !isListVisible });
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* FlowList container with improved animation */}
      <Fade in={isListVisible} timeout={{ enter: 500, exit: 300 }}>
        <ListContainer isVisible={isListVisible} isCollapsed={isListCollapsed}>
          <Box sx={{ p: 2 }}>
            <FlowList
              flows={flows}
              selectedFlow={selectedFlow}
              onSelectFlow={onSelectFlow}
              onDeleteFlow={onDeleteFlow}
              onCopyFlow={onCopyFlow}
              isLoading={isLoading}
            />
          </Box>
        </ListContainer>
      </Fade>
      
      {/* Toggle button with improved positioning */}
      <ToggleButton 
        variant="contained" 
        onClick={toggleList}
        startIcon={isListVisible ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
        sx={{ 
          top: isListVisible ? 'auto' : 0,
          bottom: isListVisible ? 0 : 'auto',
          transform: isListVisible ? 'translateY(100%)' : 'none',
        }}
      >
        {isListVisible ? 'Hide List' : 'Show List'}
      </ToggleButton>
      
      {/* Content container (FlowBuilder) with improved spacing */}
      <ContentContainer fullscreen={!isListVisible}>
        {selectedFlow ? (
          children
        ) : (
          <Box 
            sx={{ 
              flex: 1, 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              flexDirection: 'column',
              p: 4,
              backgroundColor: 'background.paper',
              borderRadius: 1,
              m: 2
            }}
          >
            <Typography variant="h6" gutterBottom>
              Select a flow from the list above or create a new one
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center">
              The canvas will appear here once you select or create a flow.
            </Typography>
          </Box>
        )}
      </ContentContainer>
    </Box>
  );
};

export default FlowLayout;
