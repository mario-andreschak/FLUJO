'use client';

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Paper,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import SentimentDissatisfiedOutlinedIcon from '@mui/icons-material/SentimentDissatisfiedOutlined';
import SentimentSatisfiedAltOutlinedIcon from '@mui/icons-material/SentimentSatisfiedAltOutlined';

type Sentiment = 'happy' | 'unhappy';

const ratingFor = (sentiment: Sentiment): 1 | 5 => sentiment === 'happy' ? 5 : 1;

export default function FeedbackBanner() {
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const characterCount = Array.from(notice).length;
  const trimmedCharacterCount = Array.from(notice.trim()).length;
  const canSubmit = sentiment !== null && trimmedCharacterCount >= 1 && trimmedCharacterCount <= 255;

  const handleSubmit = async () => {
    if (!sentiment || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/registry/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notice: notice.trim(),
          rating: ratingFor(sentiment),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not submit feedback.');
        return;
      }
      setSubmitted(true);
    } catch {
      setError('Could not submit feedback. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <Alert severity="success" sx={{ mb: 4 }}>
        Thanks for helping improve FLUJO.
      </Alert>
    );
  }

  return (
    <Paper
      component="section"
      aria-labelledby="feedback-banner-title"
      variant="outlined"
      sx={{ mb: 4, p: { xs: 2, sm: 2.5 } }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: { xs: 'stretch', md: 'center' },
          gap: 2,
        }}
      >
        <Box sx={{ flex: '0 0 auto' }}>
          <Typography id="feedback-banner-title" variant="subtitle1" fontWeight={600}>
            Are you happy with FLUJO?
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Tell us what is working—or what could be better.
          </Typography>
        </Box>

        <ToggleButtonGroup
          exclusive
          value={sentiment}
          onChange={(_, value: Sentiment | null) => {
            if (value) setSentiment(value);
          }}
          aria-label="Are you happy with FLUJO?"
          size="small"
        >
          <ToggleButton value="happy" aria-label="Yes, I am happy">
            <SentimentSatisfiedAltOutlinedIcon sx={{ mr: 0.75 }} />
            Yes
          </ToggleButton>
          <ToggleButton value="unhappy" aria-label="No, I am not happy">
            <SentimentDissatisfiedOutlinedIcon sx={{ mr: 0.75 }} />
            Not really
          </ToggleButton>
        </ToggleButtonGroup>

        <TextField
          value={notice}
          onChange={(event) => setNotice(event.target.value)}
          placeholder="Share your feedback"
          size="small"
          multiline
          maxRows={3}
          inputProps={{ maxLength: 255, 'aria-label': 'Feedback' }}
          helperText={`${characterCount}/255`}
          sx={{ flex: '1 1 280px' }}
        />

        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          sx={{ alignSelf: { xs: 'stretch', md: 'flex-start' }, minWidth: 96 }}
        >
          {submitting ? 'Sending…' : 'Send'}
        </Button>
      </Box>
      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
    </Paper>
  );
}
