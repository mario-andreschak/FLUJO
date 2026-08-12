"use client";

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { TOUR_STEPS } from '@/frontend/components/Tour/tourSteps';
import { BIG_TUTORIAL_STEP_BY_ID } from '@/frontend/components/Tour/bigTutorialSteps';
import {
  BIG_TUTORIAL_EVENT,
  emitBigTutorialEvent,
  isBigTutorialEvent,
} from '@/frontend/components/Tour/bigTutorialEvents';
import {
  buildTutorialChatFlow,
  findTutorialChatFlow,
  TUTORIAL_CHAT_PROMPT,
  TUTORIAL_WEB_QUESTION,
} from '@/frontend/components/Tour/bigTutorialFlow';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import { mcpService } from '@/frontend/services/mcp';
import type { Flow } from '@/shared/types/flow';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { TutorialProgress } from '@/shared/types/storage/storage';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/contexts/TourContext');

const DEFAULT_BIG_PROGRESS: TutorialProgress = {
  status: 'active',
  stepId: 'intro',
};

interface TourContextType {
  /** True while the first-run guided tour is running. */
  isActive: boolean;
  /** Index of the current step within TOUR_STEPS. */
  stepIndex: number;
  startTour: () => void;
  next: () => void;
  back: () => void;
  endTour: () => void;

  isBigTutorialActive: boolean;
  bigTutorialProgress: TutorialProgress;
  bigTutorialBusy: boolean;
  bigTutorialError: string | null;
  bigTutorialRunStatus: 'running' | 'completed' | 'error' | null;
  bigTutorialConnectedServer: string | null;
  startBigTutorial: () => Promise<void>;
  resumeBigTutorial: () => Promise<void>;
  nextBigTutorial: () => Promise<void>;
  backBigTutorial: () => Promise<void>;
  runBigTutorialAction: () => Promise<void>;
  pauseBigTutorial: () => Promise<void>;
  cancelBigTutorial: () => Promise<void>;
}

const TourContext = createContext<TourContextType>({
  isActive: false,
  stepIndex: 0,
  startTour: () => {},
  next: () => {},
  back: () => {},
  endTour: () => {},
  isBigTutorialActive: false,
  bigTutorialProgress: DEFAULT_BIG_PROGRESS,
  bigTutorialBusy: false,
  bigTutorialError: null,
  bigTutorialRunStatus: null,
  bigTutorialConnectedServer: null,
  startBigTutorial: async () => {},
  resumeBigTutorial: async () => {},
  nextBigTutorial: async () => {},
  backBigTutorial: async () => {},
  runBigTutorialAction: async () => {},
  pauseBigTutorial: async () => {},
  cancelBigTutorial: async () => {},
});

export const useTour = () => useContext(TourContext);

function webCapabilityScore(value: string): number {
  const normalized = value.toLocaleLowerCase();
  const weighted = [
    ['web search', 12], ['internet', 10], ['search_web', 10], ['web_search', 10],
    ['brave', 9], ['duckduckgo', 9], ['google search', 9], ['news', 7],
    ['browser', 6], ['search', 5], ['fetch', 2],
  ] as const;
  return weighted.reduce((score, [term, weight]) => score + (normalized.includes(term) ? weight : 0), 0);
}

export const TourProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { settings, updateSettings, isLoading, settingsHydrated } = useStorage();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [isActive, setIsActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [isBigTutorialActive, setIsBigTutorialActive] = useState(false);
  const [bigTutorialProgress, setBigTutorialProgress] = useState<TutorialProgress>(
    settings.onboarding?.tutorials?.bigTutorialStage1 ?? DEFAULT_BIG_PROGRESS,
  );
  const bigProgressRef = useRef(bigTutorialProgress);
  bigProgressRef.current = bigTutorialProgress;
  const [bigTutorialBusy, setBigTutorialBusy] = useState(false);
  const [bigTutorialError, setBigTutorialError] = useState<string | null>(null);
  const [bigTutorialRunStatus, setBigTutorialRunStatus] = useState<'running' | 'completed' | 'error' | null>(null);
  const [bigTutorialConnectedServer, setBigTutorialConnectedServer] = useState<string | null>(null);
  const autoStartChecked = useRef(false);
  const bigAutoStartChecked = useRef(false);
  const bigPersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());

  const persistCompleted = useCallback(() => {
    const current = settingsRef.current;
    updateSettings({
      ...current,
      onboarding: { ...(current.onboarding ?? {}), completed: true },
    }).catch((error) => log.warn('Failed to persist onboarding completion', error));
  }, [updateSettings]);

  const persistBigProgress = useCallback((progress: TutorialProgress) => {
    const pending = bigPersistenceQueueRef.current.then(async () => {
      const current = settingsRef.current;
      const nextSettings = {
        ...current,
        onboarding: {
          ...(current.onboarding ?? {}),
          completed: current.onboarding?.completed ?? true,
          tutorials: {
            ...(current.onboarding?.tutorials ?? {}),
            bigTutorialStage1: progress,
          },
        },
      };
      settingsRef.current = nextSettings;
      await updateSettings(nextSettings);
    });
    const settled = pending.catch((error) => {
      log.warn('Failed to persist Stage 1 tutorial progress', error);
    });
    bigPersistenceQueueRef.current = settled;
    return settled;
  }, [updateSettings]);

  const commitBigProgress = useCallback(async (progress: TutorialProgress) => {
    bigProgressRef.current = progress;
    await persistBigProgress(progress);
    if (bigProgressRef.current === progress) setBigTutorialProgress(progress);
  }, [persistBigProgress]);

  const startTour = useCallback(() => {
    log.info('Starting guided tour');
    setIsBigTutorialActive(false);
    setStepIndex(0);
    setIsActive(true);
  }, []);

  const endTour = useCallback(() => {
    log.info('Ending guided tour');
    setIsActive(false);
    persistCompleted();
  }, [persistCompleted]);

  const next = useCallback(() => {
    setStepIndex((idx) => {
      if (idx >= TOUR_STEPS.length - 1) {
        setIsActive(false);
        persistCompleted();
        return idx;
      }
      return idx + 1;
    });
  }, [persistCompleted]);

  const back = useCallback(() => setStepIndex((idx) => Math.max(0, idx - 1)), []);

  const ensureTutorialChat = useCallback(async (): Promise<TutorialProgress> => {
    const currentProgress = bigProgressRef.current;
    const flows = await flowService.loadFlows();
    const existing = findTutorialChatFlow(flows);
    if (existing) {
      const processNode = existing.flow.nodes.find(node => node.id === existing.processNodeId);
      const taskPrompt = typeof processNode?.data.properties?.promptTemplate === 'string'
        ? processNode.data.properties.promptTemplate
        : undefined;
      const nextProgress = {
        ...currentProgress,
        flowId: existing.flow.id,
        processNodeId: existing.processNodeId,
        taskPrompt,
      };
      await commitBigProgress(nextProgress);
      return nextProgress;
    }

    const namedChat = flows.find(flow => flow.name.trim().toLocaleLowerCase() === 'chat');
    if (namedChat) {
      throw new Error('I found a Chat agent, but it has no AI step. Add one or rename that agent, then restart this tutorial.');
    }

    const models = await modelService.loadModels();
    const preferredModel = models.find(model => model.favorite && model.supportsTools !== false)
      ?? models.find(model => model.supportsTools !== false)
      ?? models.find(model => model.favorite)
      ?? models[0];
    const created = buildTutorialChatFlow(preferredModel?.id, uuidv4);
    const result = await flowService.addFlow(created.flow);
    if (!result.success) throw new Error(result.error || 'I could not create the Chat agent.');
    const nextProgress = {
      ...currentProgress,
      flowId: created.flow.id,
      processNodeId: created.processNodeId,
      taskPrompt: TUTORIAL_CHAT_PROMPT,
    };
    await commitBigProgress(nextProgress);
    return nextProgress;
  }, [commitBigProgress]);

  const startBigTutorial = useCallback(async () => {
    const progress: TutorialProgress = { ...DEFAULT_BIG_PROGRESS };
    setIsActive(false);
    setBigTutorialError(null);
    setBigTutorialConnectedServer(null);
    setBigTutorialRunStatus(null);
    await commitBigProgress(progress);
    setIsBigTutorialActive(true);
  }, [commitBigProgress]);

  const resumeBigTutorial = useCallback(async () => {
    const stored = settingsRef.current.onboarding?.tutorials?.bigTutorialStage1;
    const progress = stored && stored.status === 'paused'
      ? { ...stored, status: 'active' as const }
      : { ...DEFAULT_BIG_PROGRESS };
    setIsActive(false);
    setBigTutorialError(null);
    await commitBigProgress(progress);
    setIsBigTutorialActive(true);
    if (progress.stepId !== 'intro') {
      void ensureTutorialChat().catch((error) => {
        setBigTutorialError(error instanceof Error ? error.message : String(error));
      });
    }
  }, [commitBigProgress, ensureTutorialChat]);

  const moveBigTutorialTo = useCallback(async (stepId: string) => {
    const current = bigProgressRef.current;
    if (!BIG_TUTORIAL_STEP_BY_ID.has(stepId)) return;
    setBigTutorialError(null);
    await commitBigProgress({ ...current, status: 'active', stepId });
  }, [commitBigProgress]);

  const nextBigTutorial = useCallback(async () => {
    const step = BIG_TUTORIAL_STEP_BY_ID.get(bigProgressRef.current.stepId);
    if (step?.next) await moveBigTutorialTo(step.next);
  }, [moveBigTutorialTo]);

  const backBigTutorial = useCallback(async () => {
    const step = BIG_TUTORIAL_STEP_BY_ID.get(bigProgressRef.current.stepId);
    if (step?.back) await moveBigTutorialTo(step.back);
  }, [moveBigTutorialTo]);

  const checkForWebApp = useCallback(async () => {
    setBigTutorialConnectedServer(null);
    let progress = bigProgressRef.current;
    if (!progress.flowId || !progress.processNodeId) progress = await ensureTutorialChat();
    const flow = progress.flowId ? await flowService.getFlow(progress.flowId) : null;
    if (!flow || !progress.processNodeId) throw new Error('I cannot find the Chat agent right now. Please try again.');

    const rawConfigs = await mcpService.loadServerConfigs();
    if (!Array.isArray(rawConfigs)) throw new Error(rawConfigs?.error || 'I could not read your installed apps.');
    const configs = rawConfigs as MCPServerConfig[];
    const enabledConfigs = configs.filter(config => !config.disabled);
    const toolCatalog = await Promise.all(enabledConfigs.map(async config => {
      const result = await mcpService.listServerTools(config.name);
      return {
        config,
        tools: result.error || !Array.isArray(result.tools) ? [] : result.tools as Array<{ name: string; description?: string }>,
      };
    }));

    const processNode = flow.nodes.find(node => node.id === progress.processNodeId);
    const modelId = typeof processNode?.data.properties?.boundModel === 'string'
      ? processNode.data.properties.boundModel
      : (await modelService.loadModels())[0]?.id;
    let suggestedServerNames: string[] = [];
    if (modelId) {
      try {
        const suggestion = await flowService.suggestToolsForStep({
          flow,
          nodeId: progress.processNodeId,
          modelId,
          goal: 'Let this friendly chat agent search the web and answer questions about current news and events.',
        });
        suggestedServerNames = suggestion.suggestions
          .filter(item => webCapabilityScore(`${item.server} ${item.tool} ${item.reason}`) > 0)
          .map(item => item.server);
      } catch (error) {
        log.warn('Stage 1 app suggestion failed; using the live tool catalog', error);
      }
    }

    const ranked = toolCatalog
      .map(({ config, tools }) => ({
        name: config.name,
        score: Math.max(
          suggestedServerNames.includes(config.name) ? 100 : 0,
          ...tools.map(tool => webCapabilityScore(`${config.name} ${tool.name} ${tool.description ?? ''}`)),
        ),
        toolCount: tools.length,
      }))
      .filter(candidate => candidate.toolCount > 0 && candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    if (ranked[0]) {
      const alreadyConnected = flow.nodes.some(node =>
        node.data.type === 'mcp' && node.data.properties?.boundServer === ranked[0].name,
      );
      const next: TutorialProgress = {
        ...progress,
        status: 'active',
        recommendedServerName: ranked[0].name,
        nestedTutorialId: undefined,
        stepId: alreadyConnected
          ? 'app-instructions'
          : progress.nestedTutorialId
            ? 'return-to-app-picker'
            : 'connect-app',
      };
      await commitBigProgress(next);
      return;
    }

    const disabledCandidate = configs
      .filter(config => config.disabled)
      .map(config => ({ config, score: webCapabilityScore(`${config.name} ${config.rootPath ?? ''}`) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.config;
    if (disabledCandidate) {
      await commitBigProgress({
        ...progress,
        status: 'active',
        stepId: 'enable-app',
        recommendedServerName: disabledCandidate.name,
        nestedTutorialId: 'enable-web-app',
      });
      return;
    }

    const startingCandidate = enabledConfigs.find(config => webCapabilityScore(`${config.name} ${config.rootPath ?? ''}`) > 0);
    if (startingCandidate) {
      throw new Error(`${startingCandidate.name} is installed but is not ready yet. Give it a moment, then check again.`);
    }

    await commitBigProgress({
      ...progress,
      status: 'active',
      stepId: 'install-app-intro',
      recommendedServerName: undefined,
      nestedTutorialId: 'install-web-app',
    });
  }, [commitBigProgress, ensureTutorialChat]);

  const runBigTutorialAction = useCallback(async () => {
    const step = BIG_TUTORIAL_STEP_BY_ID.get(bigProgressRef.current.stepId);
    if (!step || bigTutorialBusy) return;
    setBigTutorialBusy(true);
    setBigTutorialError(null);
    try {
      if (step.action === 'start') {
        await ensureTutorialChat();
        if (step.next) await moveBigTutorialTo(step.next);
      } else if (step.action === 'send-example') {
        setBigTutorialRunStatus(null);
        emitBigTutorialEvent({ type: 'send-example', message: TUTORIAL_WEB_QUESTION });
        if (step.next) await moveBigTutorialTo(step.next);
      } else if (step.action === 'check-apps') {
        await checkForWebApp();
      } else if (step.action === 'finish') {
        const complete: TutorialProgress = {
          ...bigProgressRef.current,
          status: 'completed',
          stepId: 'complete',
          nestedTutorialId: undefined,
        };
        await commitBigProgress(complete);
        setIsBigTutorialActive(false);
      } else if (step.next) {
        await moveBigTutorialTo(step.next);
      }
    } catch (error) {
      setBigTutorialError(error instanceof Error ? error.message : String(error));
    } finally {
      setBigTutorialBusy(false);
    }
  }, [bigTutorialBusy, checkForWebApp, commitBigProgress, ensureTutorialChat, moveBigTutorialTo]);

  const pauseBigTutorial = useCallback(async () => {
    const paused: TutorialProgress = { ...bigProgressRef.current, status: 'paused' };
    await commitBigProgress(paused);
    setIsBigTutorialActive(false);
  }, [commitBigProgress]);

  const cancelBigTutorial = useCallback(async () => {
    const cancelled: TutorialProgress = { status: 'cancelled', stepId: 'intro' };
    await commitBigProgress(cancelled);
    setIsBigTutorialActive(false);
  }, [commitBigProgress]);

  useEffect(() => {
    const listener = (event: Event) => {
      if (!isBigTutorialEvent(event) || !isBigTutorialActive) return;
      if (event.detail.type === 'conversation-created') {
        void commitBigProgress({
          ...bigProgressRef.current,
          conversationId: event.detail.conversationId,
        });
      } else if (event.detail.type === 'chat-run-status') {
        setBigTutorialRunStatus(event.detail.status);
      } else if (event.detail.type === 'app-connected') {
        setBigTutorialConnectedServer(event.detail.serverName);
      }
    };
    window.addEventListener(BIG_TUTORIAL_EVENT, listener);
    return () => window.removeEventListener(BIG_TUTORIAL_EVENT, listener);
  }, [commitBigProgress, isBigTutorialActive]);

  useEffect(() => {
    if (isLoading || !settingsHydrated || autoStartChecked.current) return;
    autoStartChecked.current = true;
    if (settings.onboarding?.completed !== true) {
      log.info('First run detected — auto-starting guided tour');
      startTour();
    }
  }, [isLoading, settingsHydrated, settings.onboarding?.completed, startTour]);

  useEffect(() => {
    if (isLoading || !settingsHydrated || bigAutoStartChecked.current) return;
    const stored = settings.onboarding?.tutorials?.bigTutorialStage1;
    if (stored?.status === 'active') {
      bigAutoStartChecked.current = true;
      bigProgressRef.current = stored;
      setBigTutorialProgress(stored);
      setIsBigTutorialActive(true);
      if (stored.stepId !== 'intro') {
        void ensureTutorialChat().catch((error) => {
          setBigTutorialError(error instanceof Error ? error.message : String(error));
        });
      }
      return;
    }
    if (settings.onboarding?.completed !== true) {
      if (stored) bigAutoStartChecked.current = true;
      return;
    }
    bigAutoStartChecked.current = true;
    if (!stored) {
      void startBigTutorial();
    }
  }, [ensureTutorialChat, isLoading, settings.onboarding, settingsHydrated, startBigTutorial]);

  useEffect(() => {
    if (!settingsHydrated || isBigTutorialActive) return;
    const stored = settings.onboarding?.tutorials?.bigTutorialStage1;
    if (stored) {
      bigProgressRef.current = stored;
      setBigTutorialProgress(stored);
    }
  }, [isBigTutorialActive, settings.onboarding?.tutorials?.bigTutorialStage1, settingsHydrated]);

  return (
    <TourContext.Provider value={{
      isActive,
      stepIndex,
      startTour,
      next,
      back,
      endTour,
      isBigTutorialActive,
      bigTutorialProgress,
      bigTutorialBusy,
      bigTutorialError,
      bigTutorialRunStatus,
      bigTutorialConnectedServer,
      startBigTutorial,
      resumeBigTutorial,
      nextBigTutorial,
      backBigTutorial,
      runBigTutorialAction,
      pauseBigTutorial,
      cancelBigTutorial,
    }}>
      {children}
    </TourContext.Provider>
  );
};
