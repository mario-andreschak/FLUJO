// Add TypeScript declarations for Node.js globals
declare namespace NodeJS {
  interface Global {
    gc?: () => void;
  }
}

// Ensure TypeScript recognizes the gc function on the global object
interface Window {
  gc?: () => void;
} 