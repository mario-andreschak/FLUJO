// Unmodified, reviewed source captures. Framing and camera movement happen in renderer.js.
export const CAPTURES = {
  expert: { src: 'media/product-helper-expert.png', provenance: 'media/product-capture-manifest.json' },
  provider: { src: 'media/product-provider-choices.png', provenance: 'media/product-capture-manifest.json' },
  easy: { src: 'media/product-helper-easy.png', provenance: 'media/product-capture-manifest.json' },
  ai: { src: '../assets/journeys/02-ai-test.png' },
  github: { src: '../assets/journeys/03-github-url.png' },
  tool: { src: '../assets/journeys/04-mcp-test.png' },
  fetchResult: { src: 'media/product-fetch-result.png', provenance: 'media/product-capture-manifest.json' },
  answer: { src: '../assets/journeys/07-verified-checklist.png' },
  memory: { src: '../assets/journeys/10-day1-memory.png' },
  goal: { src: '../assets/journeys/13-day2-progress.png' },
  completed: { src: '../assets/journeys/16-day3-goal-completed.png' },
};
// Only genuine, privacy-reviewed action clips may be added here.
export const CLIPS = {
  fetchMotion: { src:'media/product-fetch-transition.mp4', provenance:'media/product-capture-manifest.json', start:32, end:39, sourceStart:6, rate:1, stillTime:10 },
  agentSwitch: { src:'media/product-helper-transition.mp4', provenance:'media/product-capture-manifest.json', start:22, end:27.5, sourceStart:4.5, rate:1, stillTime:8.5 },
  agentInspect: { src:'media/product-helper-transition.mp4', provenance:'media/product-capture-manifest.json', start:27.5, end:32, sourceStart:30, rate:1, stillTime:33 },
};

export const BRAND = { src: 'brand.svg' };
