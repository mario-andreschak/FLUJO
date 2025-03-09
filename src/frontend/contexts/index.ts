import { Model } from '@/shared/types'

export interface ThemeContextType {
  isDarkMode: boolean;
  toggleTheme: () => void;
}

export interface StorageContextType {
  models: Model[];
  addModel: (model: Model) => Promise<void>;
  updateModel: (model: Model) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  setKey: (key: string) => Promise<void>;
  getKey: () => Promise<string | null>;
}
