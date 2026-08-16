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
import { openGitHubNewIssue } from '@/frontend/utils/openGitHubIssue';
import { useI18n } from '@/frontend/contexts/I18nContext';

type Sentiment = 'happy' | 'unhappy';

const ratingFor = (sentiment: Sentiment): 1 | 5 => sentiment === 'happy' ? 5 : 1;

export default function FeedbackBanner() {
  const { t } = useI18n();
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackAvailable, setFallbackAvailable] = useState(false);

  const characterCount = Array.from(notice).length;
  const trimmedCharacterCount = Array.from(notice.trim()).length;
  // Issue #377: the message is optional — only the sentiment is required.
  const canSubmit = sentiment !== null && trimmedCharacterCount <= 255;

  const handleSubmit = async () => {
    if (!sentiment || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    setFallbackAvailable(false);
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
        setError(typeof body.error === 'string' ? body.error : t('feedback.submitFailed'));
        setFallbackAvailable(response.status >= 500);
        return;
      }
      setSubmitted(true);
    } catch {
      setError(t('feedback.unavailable'));
      setFallbackAvailable(true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGitHubFallback = () => {
    if (!sentiment) return;
    openGitHubNewIssue({
      title: 'FLUJO feedback',
      body: `Sentiment: ${sentiment === 'happy' ? 'Happy' : 'Not really'}\n\n${notice.trim()}`,
    });
  };

  if (submitted) {
    return (
      <Alert severity="success" sx={{ mb: 4 }}>
        {t('feedback.thanks')}
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
            {t('feedback.title')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t('feedback.description')}
          </Typography>
        </Box>

        <ToggleButtonGroup
          exclusive
          value={sentiment}
          onChange={(_, value: Sentiment | null) => {
            if (value) setSentiment(value);
          }}
          aria-label={t('feedback.title')}
          size="small"
        >
          <ToggleButton value="happy" aria-label={t('feedback.yesAria')}>
            <SentimentSatisfiedAltOutlinedIcon sx={{ mr: 0.75 }} />
            {t('feedback.yes')}
          </ToggleButton>
          <ToggleButton value="unhappy" aria-label={t('feedback.noAria')}>
            <SentimentDissatisfiedOutlinedIcon sx={{ mr: 0.75 }} />
            {t('feedback.no')}
          </ToggleButton>
        </ToggleButtonGroup>

        <TextField
          value={notice}
          onChange={(event) => setNotice(event.target.value)}
          placeholder={t('feedback.placeholder')}
          size="small"
          multiline
          maxRows={3}
          inputProps={{ maxLength: 255, 'aria-label': t('feedback.inputAria') }}
          helperText={`${characterCount}/255`}
          sx={{ flex: '1 1 280px' }}
        />

        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          sx={{ alignSelf: { xs: 'stretch', md: 'flex-start' }, minWidth: 96 }}
        >
          {submitting ? t('feedback.sending') : t('feedback.send')}
        </Button>
      </Box>
      {error && (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          onClose={() => {
            setError(null);
            setFallbackAvailable(false);
          }}
          action={fallbackAvailable ? (
            <Button color="inherit" size="small" onClick={handleGitHubFallback}>
              {t('feedback.openGitHub')}
            </Button>
          ) : undefined}
        >
          {error}
          {fallbackAvailable && ` ${t('feedback.githubFallback')}`}
        </Alert>
      )}
    </Paper>
  );
}
