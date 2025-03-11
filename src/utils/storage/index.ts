export * from '../../shared/types/storage';

// Only export client functions in a client context
export {
  saveItem,
  loadItem,
  clearItem,
  useLocalStorage,
  setEncryptionKey,
  getEncryptionKey,
} from './frontend';
