import { Box, CircularProgress } from '@mui/material';

export default function Loading() {
  return (
    <Box 
      display="flex" 
      justifyContent="center" 
      alignItems="center" 
      height="100%"
      p={4}
    >
      <CircularProgress size={40} />
    </Box>
  );
}
