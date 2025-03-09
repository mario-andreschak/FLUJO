"use client";

import React, { useState } from 'react';
import {
  Box,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import EncryptionSettings from './EncryptionSettings';
import ThemeSettings from './ThemeSettings';
import GlobalEnvSettings from './GlobalEnvSettings';
import BackupSettings from './BackupSettings';
import SpeechRecognitionSettings from './SpeechRecognitionSettings';

export default function Settings() {
  const [expanded, setExpanded] = useState<string | false>('globalEnv');

  const handleChange = (panel: string) => (event: React.SyntheticEvent, isExpanded: boolean) => {
    setExpanded(isExpanded ? panel : false);
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" gutterBottom>
        Settings
      </Typography>
      
      <Box sx={{ mt: 2 }}>
        <Accordion 
          expanded={expanded === 'globalEnv'} 
          onChange={handleChange('globalEnv')}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="globalEnv-content"
            id="globalEnv-header"
          >
            <Typography variant="h6">Global Environment Variables</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <GlobalEnvSettings />
          </AccordionDetails>
        </Accordion>
        
        <Accordion 
          expanded={expanded === 'encryption'} 
          onChange={handleChange('encryption')}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="encryption-content"
            id="encryption-header"
          >
            <Typography variant="h6">Encryption</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <EncryptionSettings />
          </AccordionDetails>
        </Accordion>
        
        <Accordion 
          expanded={expanded === 'theme'} 
          onChange={handleChange('theme')}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="theme-content"
            id="theme-header"
          >
            <Typography variant="h6">Theme</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <ThemeSettings />
          </AccordionDetails>
        </Accordion>
        
        <Accordion
          expanded={expanded === 'backup'}
          onChange={handleChange('backup')}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="backup-content"
            id="backup-header"
          >
            <Typography variant="h6">Backup & Restore</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <BackupSettings />
          </AccordionDetails>
        </Accordion>

        <Accordion
          expanded={expanded === 'speech'}
          onChange={handleChange('speech')}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="speech-content"
            id="speech-header"
          >
            <Typography variant="h6">Speech Recognition</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <SpeechRecognitionSettings />
          </AccordionDetails>
        </Accordion>
      </Box>
    </Box>
  );
}
