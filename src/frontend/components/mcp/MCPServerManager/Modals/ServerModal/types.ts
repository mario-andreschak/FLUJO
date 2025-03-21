import { MCPServerConfig } from '@/utils/mcp';

export interface ServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (config: MCPServerConfig) => void;
  initialConfig?: MCPServerConfig | null;
  onUpdate?: (config: MCPServerConfig) => void;
  onRestartAfterUpdate?: (serverName: string) => void;
}

export interface MessageState {
  type: 'success' | 'error' | 'warning';
  text: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  valid: boolean;
  contents?: any;
}

export interface TabProps {
  initialConfig?: MCPServerConfig | null;
  onAdd: (config: MCPServerConfig) => void;
  onUpdate?: (config: MCPServerConfig) => void;
  onClose: () => void;
  onRestartAfterUpdate?: (serverName: string) => void;
  setActiveTab?: (tab: 'github' | 'local' | 'smithery' | 'reference') => void;
}
