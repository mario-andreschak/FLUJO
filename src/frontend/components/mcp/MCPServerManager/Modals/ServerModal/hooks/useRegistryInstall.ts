'use client';

/**
 * The one registry install pipeline (#392):
 *   getInstallOptions → selection → missingRequiredInputs → buildConfigFromOption → handoff.
 *
 * Spotlight and Marketplace used to carry parallel copies of this flow. The
 * differences between them are real and stay explicit options rather than being
 * flattened away:
 *  - `requireTrust` — Marketplace gates every install behind the trust checkbox;
 *    Spotlight's entries are curated and shipped in-repo, so it does not.
 *  - `envDefaults`  — Spotlight merges curated env defaults into the generated
 *    config (and those values count as "provided" for required-input checks).
 */

import { useCallback, useState } from 'react';
import {
  applySpotlightEnvDefaults,
  buildConfigFromOption,
  getInstallOptions,
  missingRequiredInputs,
  type InstallOption,
  type ManualLaunchOption,
  type RegistryServer
} from '@/utils/mcp/registry';
import type { MCPServerConfig } from '@/shared/types/mcp/mcp';
import type { TabHandoff } from '../types';

export interface RegistryInstallSelection {
  server: RegistryServer;
  options: InstallOption[];
  envDefaults?: Record<string, string>;
}

export interface UseRegistryInstallArgs {
  /** Require an explicit trust confirmation before any install action. */
  requireTrust: boolean;
  onHandoff?: (handoff: TabHandoff) => void;
}

export interface UseRegistryInstall {
  selection: RegistryInstallSelection | null;
  /** Options for the current selection (empty when nothing is selected). */
  options: InstallOption[];
  trustConfirmed: boolean;
  setTrustConfirmed: (confirmed: boolean) => void;
  /** True while an install action must stay disabled. */
  installBlocked: boolean;
  open: (server: RegistryServer, envDefaults?: Record<string, string>) => InstallOption[];
  close: () => void;
  /**
   * Build the config for `option` and hand it to the configure-and-verify sink.
   * Returns the required inputs the registry entry did not supply, so the caller
   * can warn (both tabs surface this now — Spotlight previously did not).
   */
  install: (
    server: RegistryServer,
    option: InstallOption,
    envDefaults?: Record<string, string>
  ) => string[];
  /**
   * Launch-and-connect (#392): persist the entry as an ordinary HTTP server with
   * its `launch` spec attached. No auto test run — nothing is listening until
   * the user starts the process themselves.
   */
  configureAsRemote: (
    server: RegistryServer,
    option: ManualLaunchOption,
    envDefaults?: Record<string, string>
  ) => void;
  missingFor: (option: InstallOption, envDefaults?: Record<string, string>) => string[];
}

export function useRegistryInstall({ requireTrust, onHandoff }: UseRegistryInstallArgs): UseRegistryInstall {
  const [selection, setSelection] = useState<RegistryInstallSelection | null>(null);
  const [trustConfirmed, setTrustConfirmed] = useState<boolean>(false);

  const open = useCallback((server: RegistryServer, envDefaults?: Record<string, string>) => {
    const options = getInstallOptions(server);
    // The trust gate is per-server: never carry a previous confirmation over.
    setTrustConfirmed(false);
    setSelection({ server, options, ...(envDefaults ? { envDefaults } : {}) });
    return options;
  }, []);

  const close = useCallback(() => {
    setSelection(null);
    setTrustConfirmed(false);
  }, []);

  const buildConfig = useCallback(
    (server: RegistryServer, option: InstallOption, envDefaults?: Record<string, string>) =>
      applySpotlightEnvDefaults(buildConfigFromOption(server, option), envDefaults) as MCPServerConfig,
    []
  );

  const install = useCallback(
    (server: RegistryServer, option: InstallOption, envDefaults?: Record<string, string>) => {
      const config = buildConfig(server, option, envDefaults);
      const missing = missingRequiredInputs(option, envDefaults);
      close();
      // autoTestRun: registry configs need no manual install/build step, so the
      // configure tab can start the test run (which performs the install) at once.
      onHandoff?.({ to: 'configure', config, autoTestRun: true });
      return missing;
    },
    [buildConfig, close, onHandoff]
  );

  const configureAsRemote = useCallback(
    (server: RegistryServer, option: ManualLaunchOption, envDefaults?: Record<string, string>) => {
      const config = buildConfig(server, option, envDefaults);
      close();
      onHandoff?.({ to: 'configure', config });
    },
    [buildConfig, close, onHandoff]
  );

  const missingFor = useCallback(
    (option: InstallOption, envDefaults?: Record<string, string>) =>
      missingRequiredInputs(option, envDefaults),
    []
  );

  return {
    selection,
    options: selection?.options ?? [],
    trustConfirmed,
    setTrustConfirmed,
    installBlocked: requireTrust && !trustConfirmed,
    open,
    close,
    install,
    configureAsRemote,
    missingFor
  };
}

export default useRegistryInstall;
