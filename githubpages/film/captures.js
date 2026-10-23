import { SHOTS } from './timeline.js';

// Media required by the published player. Keep unused production captures offline.
export const SOURCES = Object.freeze({
  "opening": {
    "kind": "video",
    "src": "media/walkthrough/act1-open-ai-setup.mp4"
  },
  "model-setup": {
    "kind": "video",
    "src": "media/walkthrough/act1-model-setup.mp4"
  },
  "model-test": {
    "kind": "video",
    "src": "media/walkthrough/act1-model-test.mp4"
  },
  "tool-import": {
    "kind": "video",
    "src": "media/walkthrough/act2-github-import.mp4"
  },
  "tool-install": {
    "kind": "video",
    "src": "media/walkthrough/act2-install-build-test.mp4"
  },
  "tool-connected": {
    "kind": "video",
    "src": "media/walkthrough/act2-tool-connected.mp4"
  },
  "agent-create": {
    "kind": "video",
    "src": "media/walkthrough/act3-agent-create.mp4"
  },
  "agent-bindings": {
    "kind": "video",
    "src": "media/walkthrough/act3-agent-bindings.mp4"
  },
  "agent-save": {
    "kind": "video",
    "src": "media/walkthrough/act3-agent-save-and-chat.mp4"
  },
  "website-first-hero": {
    "kind": "image",
    "src": "media/walkthrough/act4-site-desktop-hero.png"
  },
  "website-first-signup": {
    "kind": "image",
    "src": "media/walkthrough/act4-site-desktop-signup.png"
  },
  "feature-tour": {
    "kind": "video",
    "src": "media/walkthrough/act5-feature-tour.mp4"
  },
  "website-build": {
    "kind": "video",
    "src": "media/walkthrough/act4-build.mp4"
  },
  "website-revision": {
    "kind": "video",
    "src": "media/walkthrough/act4-revision-and-preview.mp4"
  },
  "site-acceptance": {
    "kind": "video",
    "src": "media/walkthrough/act4-site-acceptance.mp4"
  }
});
export const CAPTURES = Object.fromEntries(Object.entries(SOURCES).filter(([, source]) => source.kind === 'image'));
export const CLIPS = Object.fromEntries(SHOTS.filter(shot => shot.type === 'footage' && SOURCES[shot.source]?.kind === 'video').map(shot => {
  const source = SOURCES[shot.source];
  return [shot.id, {
    ...source, start: shot.start, end: shot.end,
    sourceStart: shot.sourceStart || 0, sourceEnd: shot.sourceEnd,
    holdLead: shot.holdLead || 0, holdTail: shot.holdTail || 0,
    rate: 1, stillTime: shot.stillTime ?? shot.sourceStart ?? 0,
  }];
}));
export const BRAND = { src: 'brand.svg' };
