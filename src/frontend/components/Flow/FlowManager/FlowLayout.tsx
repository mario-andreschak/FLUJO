"use client";

import React, { useState, useEffect } from 'react';
import { Box, Button, Divider, Typography, styled } from '@mui/material';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import FlowList from './FlowBuilder/FlowList';
import { Flow } from '@/frontend/types/flow/flow';

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
  transition: 'transform 0.3s ease, max-height 0.3s ease, opacity 0.3s ease',
  transform: isVisible ? 'translateY(0)' : 'translateY(-100%)',
  maxHeight: isCollapsed ? '0' : '300px',
  opacity: isVisible ? 1 : 0,
  overflow: 'hidden',
  position: 'relative',
  zIndex: 10,
  backgroundColor: theme.palette.background.paper,
  borderBottom: `1px solid ${theme.palette.divider}`,
}));

const ToggleButton = styled(Button)(({ theme }) => ({
  position: 'absolute',
  top: 0,
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
}));

const ContentContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'fullscreen',
})<{ fullscreen: boolean }>(({ fullscreen }) => ({
  flex: 1,
  transition: 'height 0.3s ease',
  height: fullscreen ? 'calc(100vh - 64px)' : 'calc(100vh - 64px - 200px)',
  overflow: 'hidden',
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
  
  // When a flow is selected, collapse the list
  useEffect(() => {
    if (selectedFlow) {
      setIsListVisible(false);
    } else {
      setIsListVisible(true);
    }
  }, [selectedFlow]);
  
  // Handle the animation timing for collapsing
  useEffect(() => {
    let timer: NodeJS.Timeout;
    
    if (!isListVisible) {
      // When hiding, start collapsing after the slide-up animation starts
      timer = setTimeout(() => {
        setIsListCollapsed(true);
      }, 150);
    } else {
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
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* FlowList container with animation */}
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
      
      {/* Toggle button - only show when a flow is selected */}
      {selectedFlow && (
        <ToggleButton 
          variant="contained" 
          onClick={toggleList}
          startIcon={isListVisible ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
          sx={{ 
            top: 0,
          }}
        >
          {isListVisible ? 'Hide List' : 'Show List'}
        </ToggleButton>
      )}
      
      {/* Divider - only show when list is visible */}
      {isListVisible && <Divider />}
      
      {/* Content container (FlowBuilder) */}
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
