// Chromium-only File System Access API; TypeScript's DOM library does not declare it yet.
interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}
