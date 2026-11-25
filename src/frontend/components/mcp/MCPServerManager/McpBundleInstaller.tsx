'use client';

/**
 * Install an MCP bundle (.mcpb) by dropping it on the Connected Apps page or
 * choosing it from the Import menu (#1230). FLUJO first shows what the bundle
 * is and what it will run; nothing is unpacked or started until the person
 * presses Install.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Link,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import { installMcpbFile, isMcpbFileName, McpbRequestError, reviewMcpbFile } from '@/frontend/services/mcp/bundles';
import type {
  McpbInstallResult,
  McpbPlatform,
  McpbReview,
  McpbReviewWarning,
  McpbServerType,
  McpbSignatureStatus,
  McpbUserConfigField,
  McpbUserConfigValue,
} from '@/shared/types/mcp/mcpb';

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_LISTED = 12;

const PLATFORM_KEYS: Record<McpbPlatform, TranslationKey> = {
  darwin: 'mcp.bundle.platform.darwin',
  win32: 'mcp.bundle.platform.win32',
  linux: 'mcp.bundle.platform.linux',
};
const TYPE_KEYS: Record<McpbServerType, TranslationKey> = {
  node: 'mcp.bundle.type.node',
  python: 'mcp.bundle.type.python',
  binary: 'mcp.bundle.type.binary',
  uv: 'mcp.bundle.type.uv',
};
const SIGNATURE_KEYS: Record<McpbSignatureStatus, TranslationKey> = {
  unsigned: 'mcp.bundle.signature.unsigned',
  'signed-unverified': 'mcp.bundle.signature.signed-unverified',
  damaged: 'mcp.bundle.signature.damaged',
};
const WARNING_KEYS: Record<McpbReviewWarning, TranslationKey> = {
  'secret-in-command-line': 'mcp.bundle.warning.secret-in-command-line',
  'runs-bundled-program': 'mcp.bundle.warning.runs-bundled-program',
  'installs-python-packages': 'mcp.bundle.warning.installs-python-packages',
  'newer-format': 'mcp.bundle.warning.newer-format',
  'signature-damaged': 'mcp.bundle.warning.signature-damaged',
};

type FormValue = string | boolean;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function platformLabel(platform: string, t: (key: TranslationKey) => string): string {
  return platform in PLATFORM_KEYS ? t(PLATFORM_KEYS[platform as McpbPlatform]) : platform;
}

function initialValue(field: McpbUserConfigField): FormValue {
  if (field.sensitive) return '';
  const value = field.savedValue ?? field.default;
  if (field.type === 'boolean') return value === true;
  if (Array.isArray(value)) return value.join('\n');
  return value === undefined ? '' : String(value);
}

function submittedValues(fields: McpbUserConfigField[], values: Record<string, FormValue>): Record<string, McpbUserConfigValue> {
  return Object.fromEntries(fields.map((field) => [field.key, values[field.key] ?? '']));
}

interface InstallerError {
  message: string;
  fields: string[];
}

export interface McpBundleInstaller {
  /** Spread on the page container so a dropped .mcpb file opens the review. */
  dropZoneProps: Pick<React.HTMLAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  openFilePicker: () => void;
  element: React.ReactNode;
}

export function useMcpBundleInstaller({ onInstalled }: { onInstalled: (result: McpbInstallResult) => void }): McpBundleInstaller {
  const { t, formatNumber } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const requestId = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState<McpbReview | null>(null);
  const [busy, setBusy] = useState<'reading' | 'installing' | null>(null);
  const [error, setError] = useState<InstallerError | null>(null);
  const [result, setResult] = useState<McpbInstallResult | null>(null);
  const [serverName, setServerName] = useState('');
  const [values, setValues] = useState<Record<string, FormValue>>({});

  const startReview = useCallback(async (candidate: File) => {
    const id = ++requestId.current;
    setOpen(true);
    setResult(null);
    setReview(null);
    setError(null);
    setFile(candidate);
    if (!isMcpbFileName(candidate.name)) {
      setBusy(null);
      setError({ message: t('mcp.bundle.onlyMcpb'), fields: [] });
      return;
    }
    setBusy('reading');
    try {
      const next = await reviewMcpbFile(candidate, t('mcp.bundle.requestFailed'));
      if (id !== requestId.current) return;
      setReview(next);
      setServerName(next.suggestedServerName);
      setValues(Object.fromEntries(next.userConfig.map((field) => [field.key, initialValue(field)])));
    } catch (failure) {
      if (id !== requestId.current) return;
      setError({ message: failure instanceof Error ? failure.message : String(failure), fields: [] });
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  }, [t]);

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const close = useCallback(() => {
    if (busy === 'installing') return;
    requestId.current += 1;
    setOpen(false);
    setBusy(null);
  }, [busy]);

  const install = useCallback(async () => {
    if (!file || !review) return;
    const id = ++requestId.current;
    setBusy('installing');
    setError(null);
    try {
      const installed = await installMcpbFile(file, {
        reviewedDigest: review.digest,
        serverName: serverName.trim(),
        userConfig: submittedValues(review.userConfig, values),
      }, t('mcp.bundle.requestFailed'));
      if (id !== requestId.current) return;
      setResult(installed);
      onInstalled(installed);
    } catch (failure) {
      if (id !== requestId.current) return;
      setError({
        message: failure instanceof Error ? failure.message : String(failure),
        fields: failure instanceof McpbRequestError ? failure.fields : [],
      });
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  }, [file, review, serverName, values, onInstalled, t]);

  const hasFiles = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const fromThisPage = (event: React.DragEvent<HTMLElement>) => event.target instanceof Node && event.currentTarget.contains(event.target);

  const dropZoneProps: McpBundleInstaller['dropZoneProps'] = {
    onDragEnter: (event) => {
      if (!hasFiles(event) || !fromThisPage(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    },
    onDragOver: (event) => {
      if (!hasFiles(event) || !fromThisPage(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    },
    onDrop: (event) => {
      dragDepth.current = 0;
      setDragActive(false);
      if (event.defaultPrevented || !hasFiles(event) || !fromThisPage(event)) return;
      event.preventDefault();
      const dropped = event.dataTransfer.files?.[0];
      if (dropped) void startReview(dropped);
    },
  };

  const nameValid = SERVER_NAME.test(serverName.trim());
  const upgrading = Boolean(review?.existing);
  const canInstall = Boolean(review && review.platformSupported && nameValid && !busy && !result);

  const renderField = (field: McpbUserConfigField) => {
    const value = values[field.key];
    const fieldError = error?.fields.includes(field.key) ?? false;
    const setValue = (next: FormValue) => setValues((current) => ({ ...current, [field.key]: next }));
    if (field.type === 'boolean') {
      return (
        <Box key={field.key}>
          <FormControlLabel
            control={<Switch checked={value === true} onChange={(event) => setValue(event.target.checked)} />}
            label={field.title}
          />
          {field.description && <Typography variant="caption" color="text.secondary" component="p">{field.description}</Typography>}
        </Box>
      );
    }
    const help = [
      field.description,
      field.type === 'directory' || field.type === 'file' ? t(field.multiple ? 'mcp.bundle.pathsHelp' : 'mcp.bundle.pathHelp') : '',
      field.type === 'number' && field.min !== undefined && field.max !== undefined
        ? t('mcp.bundle.numberRange', { min: field.min, max: field.max })
        : '',
      field.sensitive ? (field.hasSavedSecret ? t('mcp.bundle.keepSecret') : t('mcp.bundle.secretStored')) : '',
    ].filter(Boolean).join(' ');
    return (
      <TextField
        key={field.key}
        label={field.title}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => setValue(event.target.value)}
        required={field.required && !field.hasSavedSecret}
        error={fieldError}
        helperText={help || undefined}
        type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'}
        multiline={field.multiple}
        minRows={field.multiple ? 2 : undefined}
        autoComplete={field.sensitive ? 'new-password' : 'off'}
        size="small"
        fullWidth
        slotProps={{ htmlInput: { ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}), 'data-config-key': field.key } }}
      />
    );
  };

  const renderList = (items: Array<{ name: string; description?: string }>) => (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {items.slice(0, MAX_LISTED).map((item) => (
        <li key={item.name}>
          <Typography variant="body2" component="span" sx={{ fontFamily: 'monospace' }}>{item.name}</Typography>
          {item.description && <Typography variant="body2" component="span" color="text.secondary">{` — ${item.description}`}</Typography>}
        </li>
      ))}
      {items.length > MAX_LISTED && <li><Typography variant="body2" color="text.secondary">{`+${formatNumber(items.length - MAX_LISTED)}`}</Typography></li>}
    </Box>
  );

  const renderReview = (current: McpbReview) => {
    const links: Array<[TranslationKey, string | undefined]> = [
      ['mcp.bundle.link.homepage', current.homepage],
      ['mcp.bundle.link.repository', current.repositoryUrl],
      ['mcp.bundle.link.documentation', current.documentation],
      ['mcp.bundle.link.support', current.support],
    ];
    return (
      <Stack spacing={2}>
        <Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h6" component="p">{current.displayName}</Typography>
            <Chip size="small" label={t('mcp.bundle.version', { version: current.version })} />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {current.author.url
              ? <Link href={current.author.url} target="_blank" rel="noopener noreferrer">{t('mcp.bundle.byAuthor', { author: current.author.name })}</Link>
              : t('mcp.bundle.byAuthor', { author: current.author.name })}
            {current.license ? ` · ${t('mcp.bundle.license', { license: current.license })}` : ''}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>{current.description}</Typography>
          <Stack direction="row" spacing={2} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap' }}>
            {links.filter(([, href]) => href).map(([key, href]) => (
              <Link key={key} href={href} target="_blank" rel="noopener noreferrer" variant="body2">{t(key)}</Link>
            ))}
          </Stack>
        </Box>

        {!current.platformSupported && (
          <Alert severity="error">
            {t('mcp.bundle.wrongPlatform', {
              platform: platformLabel(current.thisPlatform, t),
              platforms: current.platforms.map((platform) => platformLabel(platform, t)).join(', '),
            })}
          </Alert>
        )}
        {current.existing && (
          <Alert severity="info">
            {t('mcp.bundle.upgradeInfo', { name: current.existing.serverName, from: current.existing.version, to: current.version })}
          </Alert>
        )}

        <Box>
          <Typography variant="subtitle2">{t('mcp.bundle.section.runs')}</Typography>
          <Typography variant="body2">{t(TYPE_KEYS[current.serverType])}</Typography>
          <Box
            component="pre"
            aria-label={t('mcp.bundle.section.runs')}
            sx={{ m: 0, mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'action.hover', fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {[current.launch.command, ...current.launch.args].join(' ')}
          </Box>
          {current.launch.envNames.length > 0 && (
            <Typography variant="caption" color="text.secondary" component="p">
              {t('mcp.bundle.envNames', { names: current.launch.envNames.join(', ') })}
            </Typography>
          )}
          {current.serverType === 'node' && current.runtimes.node && (
            <Typography variant="caption" color="text.secondary" component="p">
              {t('mcp.bundle.needsNode', { range: current.runtimes.node, version: current.flujoNodeVersion })}
            </Typography>
          )}
          {(current.serverType === 'python' || current.serverType === 'uv') && current.runtimes.python && (
            <Typography variant="caption" color="text.secondary" component="p">
              {t('mcp.bundle.needsPython', { range: current.runtimes.python })}
            </Typography>
          )}
        </Box>

        <Box>
          <Typography variant="subtitle2">{t('mcp.bundle.section.trust')}</Typography>
          <Typography variant="body2">{t('mcp.bundle.trustNote', { author: current.author.name })}</Typography>
          <Chip
            size="small"
            sx={{ mt: 0.5, height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', py: 0.25 } }}
            color={current.signature.status === 'damaged' ? 'error' : 'default'}
            label={t(SIGNATURE_KEYS[current.signature.status])}
          />
          {current.warnings.map((warning) => (
            <Alert key={warning} severity="warning" sx={{ mt: 1 }}>
              {t(WARNING_KEYS[warning], { version: current.manifestVersion })}
            </Alert>
          ))}
        </Box>

        <Box>
          <Typography variant="subtitle2">{t('mcp.bundle.section.platforms')}</Typography>
          <Typography variant="body2">
            {current.platforms.length === 0
              ? t('mcp.bundle.platform.all')
              : current.platforms.map((platform) => platformLabel(platform, t)).join(', ')}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {t('mcp.bundle.files', {
              count: formatNumber(current.files.count),
              packed: formatBytes(current.files.packedBytes),
              unpacked: formatBytes(current.files.unpackedBytes),
            })}
          </Typography>
        </Box>

        <Box>
          <Typography variant="subtitle2">{t('mcp.bundle.section.tools')}</Typography>
          {current.tools.length > 0
            ? renderList(current.tools)
            : <Typography variant="body2" color="text.secondary">{t('mcp.bundle.noTools')}</Typography>}
          {current.tools.length > 0 && current.toolsGenerated && (
            <Typography variant="caption" color="text.secondary" component="p">{t('mcp.bundle.toolsMore')}</Typography>
          )}
        </Box>
        {current.prompts.length > 0 && (
          <Box>
            <Typography variant="subtitle2">{t('mcp.bundle.section.prompts')}</Typography>
            {renderList(current.prompts)}
          </Box>
        )}
        {current.privacyPolicies.length > 0 && (
          <Box>
            <Typography variant="subtitle2">{t('mcp.bundle.privacy')}</Typography>
            {current.privacyPolicies.map((url) => (
              <Link key={url} href={url} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ display: 'block' }}>{url}</Link>
            ))}
          </Box>
        )}

        <Divider />
        <TextField
          label={t('mcp.bundle.section.name')}
          value={serverName}
          onChange={(event) => setServerName(event.target.value)}
          disabled={upgrading}
          error={!nameValid}
          helperText={t('mcp.bundle.nameHelp')}
          size="small"
          fullWidth
        />
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('mcp.bundle.section.settings')}</Typography>
          {current.userConfig.length === 0
            ? <Typography variant="body2" color="text.secondary">{t('mcp.bundle.settingsNone')}</Typography>
            : <Stack spacing={2}>{current.userConfig.map(renderField)}</Stack>}
        </Box>
      </Stack>
    );
  };

  const title = review?.existing ? t('mcp.bundle.titleUpgrade', { name: review.existing.serverName }) : t('mcp.bundle.title');

  const element = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".mcpb,.dxt"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="mcpb-file-input"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) void startReview(chosen);
        }}
      />
      {dragActive && (
        <Box
          aria-hidden="true"
          sx={{
            position: 'fixed',
            inset: 12,
            zIndex: (theme) => theme.zIndex.modal - 1,
            pointerEvents: 'none',
            border: 3,
            borderStyle: 'dashed',
            borderColor: 'primary.main',
            borderRadius: 3,
            bgcolor: 'background.paper',
            opacity: 0.92,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
          }}
        >
          <UploadFileIcon color="primary" fontSize="large" />
          <Typography variant="h6" color="primary">{t('mcp.bundle.dropHere')}</Typography>
        </Box>
      )}
      <Dialog open={open} onClose={close} maxWidth="md" fullWidth scroll="paper" aria-labelledby="mcpb-install-title">
        <DialogTitle id="mcpb-install-title">{title}</DialogTitle>
        <DialogContent dividers>
          {busy === 'reading' && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }} role="status">
              <CircularProgress size={20} />
              <Typography variant="body2">{t('mcp.bundle.reading')}</Typography>
            </Stack>
          )}
          {result ? (
            <Alert severity="success" role="status">
              {result.upgraded
                ? t('mcp.bundle.upgraded', { name: result.serverName, version: result.version })
                : t('mcp.bundle.installed', { name: result.serverName })}
            </Alert>
          ) : review ? renderReview(review) : null}
          {error && <Alert severity="error" role="alert" sx={{ mt: review ? 2 : 0 }}>{error.message}</Alert>}
        </DialogContent>
        <DialogActions>
          {!result && (!review || error) && busy !== 'installing' && (
            <Button onClick={openFilePicker} startIcon={<UploadFileIcon />}>{t('mcp.bundle.chooseAnother')}</Button>
          )}
          <Button onClick={close} disabled={busy === 'installing'}>{t('mcp.bundle.close')}</Button>
          {review && !result && (
            <Button
              variant="contained"
              onClick={() => void install()}
              disabled={!canInstall}
              startIcon={busy === 'installing' ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {busy === 'installing' ? t('mcp.bundle.installing') : upgrading ? t('mcp.bundle.update') : t('mcp.bundle.install')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );

  return { dropZoneProps, openFilePicker, element };
}
