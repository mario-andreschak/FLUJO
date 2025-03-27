import { modelService } from '../index';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { Model } from '@/shared/types/model';
import { encryptApiKey } from '@/utils/encryption';
import { ModelProvider } from '@/shared/types/model/provider';

// Mock dependencies
jest.mock('@/utils/storage/backend');
jest.mock('@/utils/encryption');
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn()
  })
}));

// Mock function declarations
const mockLoadItem = jest.mocked(loadItem);
const mockSaveItem = jest.mocked(saveItem);
const mockEncryptApiKey = jest.mocked(encryptApiKey);

describe('ModelService', () => {
  let service = modelService;
  const mockModels: Model[] = [
    {
      id: 'model-1',
      name: 'gpt-4',
      displayName: 'GPT-4',
      provider: 'openai' as ModelProvider,
      ApiKey: 'encrypted-key-1',
    },
    {
      id: 'model-2',
      name: 'claude-3',
      displayName: 'Claude 3',
      provider: 'anthropic' as ModelProvider,
      ApiKey: 'encrypted-key-2',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    service = modelService;
    // Setup default mock implementations
    mockLoadItem.mockResolvedValue(mockModels);
    mockSaveItem.mockResolvedValue(undefined);
    mockEncryptApiKey.mockImplementation(async (key: string) => `encrypted-${key}`);
  });

  describe('loadModels', () => {
    it('loads models from storage successfully', async () => {
      const result = await service.loadModels();
      
      expect(mockLoadItem).toHaveBeenCalledWith(StorageKey.MODELS, []);
      expect(result).toEqual(mockModels);
    });

    it('returns empty array when loading fails', async () => {
      mockLoadItem.mockRejectedValue(new Error('Storage error'));
      
      const result = await service.loadModels();
      
      expect(result).toEqual([]);
    });
  });

  describe('getModel', () => {
    it('returns a model by ID when it exists', async () => {
      const result = await service.getModel('model-1');
      
      expect(mockLoadItem).toHaveBeenCalledWith(StorageKey.MODELS, []);
      expect(result).toEqual(mockModels[0]);
    });

    it('returns null for non-existent models', async () => {
      const result = await service.getModel('non-existent-id');
      
      expect(result).toBeNull();
    });

    it('returns null when error occurs', async () => {
      mockLoadItem.mockRejectedValue(new Error('Storage error'));
      
      const result = await service.getModel('model-1');
      
      expect(result).toBeNull();
    });
  });

  describe('addModel', () => {
    const newModel: Model = {
      id: 'new-model',
      name: 'new-gpt',
      displayName: 'New GPT',
      provider: 'openai' as ModelProvider,
      ApiKey: 'api-key-123',
    };

    it('adds a new model successfully', async () => {
      const result = await service.addModel(newModel);
      
      expect(mockLoadItem).toHaveBeenCalledWith(StorageKey.MODELS, []);
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MODELS, 
        [...mockModels, newModel]
      );
      expect(result).toEqual({
        success: true,
        model: newModel
      });
    });

    it('fails when model with same name exists', async () => {
      const duplicateModel = { ...newModel, name: 'gpt-4' };
      
      const result = await service.addModel(duplicateModel);
      
      expect(mockSaveItem).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: 'A model with this technical name already exists'
      });
    });

    it('fails when model with same display name exists', async () => {
      const duplicateModel = { ...newModel, displayName: 'GPT-4' };
      
      const result = await service.addModel(duplicateModel);
      
      expect(saveItem).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: 'A model with this display name already exists'
      });
    });

    it('handles storage operation failures', async () => {
      mockSaveItem.mockRejectedValue(new Error('Storage error'));
      
      const result = await service.addModel(newModel);
      
      expect(result).toEqual({
        success: false,
        error: 'Storage error'
      });
    });
  });

  describe('updateModel', () => {
    const updatedModel: Model = {
      id: 'model-1',
      name: 'gpt-4',
      displayName: 'GPT-4 Updated',
      provider: 'openai' as ModelProvider,
      ApiKey: 'encrypted:new-api-key',
    };

    beforeEach(() => {
      mockLoadItem.mockResolvedValue(mockModels);
      mockSaveItem.mockResolvedValue(undefined);
      mockEncryptApiKey.mockImplementation(async (key: string) => key);
    });

    it('updates an existing model successfully', async () => {
      const result = await service.updateModel(updatedModel);
      
      expect(mockLoadItem).toHaveBeenCalledWith(StorageKey.MODELS, []);
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MODELS,
        mockModels.map(m => 
          m.id === updatedModel.id 
            ? { ...m, ...updatedModel }
            : m
        )
      );
      
      expect(result).toEqual({
        success: true,
        model: {
          ...mockModels[0],
          ...updatedModel,
          displayName: 'GPT-4 Updated'
        }
      });
    });

    it('fails when model does not exist', async () => {
      const nonExistentModel: Model = { 
        ...updatedModel, 
        id: 'non-existent-id' 
      };
      
      const result = await service.updateModel(nonExistentModel);
      
      expect(mockSaveItem).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: 'Model not found'
      });
    });

    it('handles encryption errors', async () => {
      const unencryptedModel = {
        ...updatedModel,
        ApiKey: 'new-api-key'
      };
      mockEncryptApiKey.mockImplementation(async (key: string) => `encrypted_failed:${key}`);
      
      const result = await service.updateModel(unencryptedModel);
      
      expect(result).toEqual({
        success: false,
        error: 'Failed to encrypt API key'
      });
    });

    it('handles storage errors', async () => {
      mockSaveItem.mockRejectedValue(new Error('Storage error'));
      
      const result = await service.updateModel(updatedModel);
      
      expect(result).toEqual({
        success: false,
        error: 'Storage error'
      });
    });
  });

  describe('deleteModel', () => {
    it('deletes a model successfully', async () => {
      const result = await service.deleteModel('model-1');
      
      expect(mockLoadItem).toHaveBeenCalledWith(StorageKey.MODELS, []);
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MODELS,
        [mockModels[1]] // Only the second model should remain
      );
      expect(result).toEqual({ success: true });
    });

    it('fails with missing model ID', async () => {
      const result = await service.deleteModel('');
      
      expect(mockSaveItem).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: 'Model ID is required'
      });
    });

    it('fails when model does not exist', async () => {
      const result = await service.deleteModel('non-existent-id');
      
      expect(mockSaveItem).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: 'Model not found'
      });
    });

    it('handles storage errors', async () => {
      mockSaveItem.mockRejectedValue(new Error('Storage error'));
      
      const result = await service.deleteModel('model-1');
      
      expect(result).toEqual({
        success: false,
        error: 'Storage error'
      });
    });
  });

  describe('listModels', () => {
    it('lists all models successfully', async () => {
      const result = await service.listModels();
      
      expect(mockLoadItem).toHaveBeenCalledWith(StorageKey.MODELS, []);
      expect(result).toEqual({
        success: true,
        models: mockModels
      });
    });

    it('handles storage errors', async () => {
      mockLoadItem.mockRejectedValue(new Error('Storage error'));
      
      const result = await service.listModels();
      
      expect(result).toEqual({
        success: true,
        models: []
      });
    });
  });
}); 