import { FlowService } from '../index';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { Flow, FlowNode } from '@/shared/types/flow';
import { Edge } from '@xyflow/react';

// Mock the storage functions
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(),
  loadItem: jest.fn(),
}));

describe('FlowService', () => {
  let flowService: FlowService;
  let mockFlows: Flow[];

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Create a new instance for each test
    flowService = new FlowService();
    
    // Setup mock data
    mockFlows = [
      {
        id: 'test-flow-1',
        name: 'Test Flow 1',
        nodes: [],
        edges: [],
      },
      {
        id: 'test-flow-2',
        name: 'Test Flow 2',
        nodes: [],
        edges: [],
      },
    ];
    
    // Setup default mock implementations
    (loadItem as jest.Mock).mockResolvedValue(mockFlows);
    (saveItem as jest.Mock).mockResolvedValue({ success: true });
  });

  describe('loadFlows', () => {
    it('should load flows from storage when cache is empty', async () => {
      const flows = await flowService.loadFlows();
      expect(loadItem).toHaveBeenCalledWith(StorageKey.FLOWS, []);
      expect(flows).toEqual(mockFlows);
    });

    it('should use cached flows when available', async () => {
      // First call to populate cache
      await flowService.loadFlows();
      
      // Second call should use cache
      const flows = await flowService.loadFlows();
      expect(loadItem).toHaveBeenCalledTimes(1);
      expect(flows).toEqual(mockFlows);
    });

    it('should handle storage errors gracefully', async () => {
      (loadItem as jest.Mock).mockRejectedValue(new Error('Storage error'));
      const flows = await flowService.loadFlows();
      expect(flows).toEqual([]);
    });
  });

  describe('getFlow', () => {
    it('should return a flow by ID', async () => {
      const flow = await flowService.getFlow('test-flow-1');
      expect(flow).toEqual(mockFlows[0]);
    });

    it('should return null for non-existent flow', async () => {
      const flow = await flowService.getFlow('non-existent');
      expect(flow).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      (loadItem as jest.Mock).mockRejectedValue(new Error('Storage error'));
      const flow = await flowService.getFlow('test-flow-1');
      expect(flow).toBeNull();
    });
  });

  describe('saveFlow', () => {
    it('should create a new flow', async () => {
      const newFlow: Flow = {
        id: 'new-flow',
        name: 'New Flow',
        nodes: [],
        edges: [],
      };

      const result = await flowService.saveFlow(newFlow);
      expect(result.success).toBe(true);
      expect(saveItem).toHaveBeenCalledWith(
        StorageKey.FLOWS,
        expect.arrayContaining([...mockFlows, newFlow])
      );
    });

    it('should update an existing flow', async () => {
      const updatedFlow = { ...mockFlows[0], name: 'Updated Flow' };
      const result = await flowService.saveFlow(updatedFlow);
      
      expect(result.success).toBe(true);
      expect(saveItem).toHaveBeenCalledWith(
        StorageKey.FLOWS,
        expect.arrayContaining([updatedFlow, mockFlows[1]])
      );
    });

    it('should handle save errors', async () => {
      (saveItem as jest.Mock).mockRejectedValue(new Error('Save error'));
      const result = await flowService.saveFlow(mockFlows[0]);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Save error');
    });
  });

  describe('deleteFlow', () => {
    it('should delete an existing flow', async () => {
      const result = await flowService.deleteFlow('test-flow-1');
      
      expect(result.success).toBe(true);
      expect(saveItem).toHaveBeenCalledWith(
        StorageKey.FLOWS,
        expect.arrayContaining([mockFlows[1]])
      );
    });

    it('should handle non-existent flow deletion gracefully', async () => {
      const result = await flowService.deleteFlow('non-existent');
      expect(result.success).toBe(true);
    });

    it('should handle delete errors', async () => {
      (saveItem as jest.Mock).mockRejectedValue(new Error('Delete error'));
      const result = await flowService.deleteFlow('test-flow-1');
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete error');
    });
  });

  describe('createNode', () => {
    it('should create a node with correct properties', () => {
      const position = { x: 100, y: 100 };
      const node = flowService.createNode('process', position);
      
      expect(node).toMatchObject({
        type: 'process',
        position,
        data: {
          label: 'Process Node',
          type: 'process',
          properties: {},
        },
      });
      expect(node.id).toBeDefined();
    });

    it('should handle MCP node type correctly', () => {
      const node = flowService.createNode('mcp', { x: 0, y: 0 });
      expect(node.data.label).toBe('MCP Node');
    });
  });

  describe('createNewFlow', () => {
    it('should create a flow with default name', () => {
      const flow = flowService.createNewFlow();
      
      expect(flow).toMatchObject({
        name: 'NewFlow',
        nodes: expect.arrayContaining([
          expect.objectContaining({
            type: 'start',
            data: expect.objectContaining({
              label: 'Start Node',
              type: 'start',
            }),
          }),
        ]),
        edges: [],
      });
      expect(flow.id).toBeDefined();
    });

    it('should create a flow with custom name', () => {
      const flow = flowService.createNewFlow('Custom Flow');
      expect(flow.name).toBe('Custom Flow');
    });
  });

  describe('createHistoryEntry', () => {
    it('should create a history entry with nodes and edges', () => {
      const nodes: FlowNode[] = [
        {
          id: 'node1',
          type: 'start',
          position: { x: 0, y: 0 },
          data: { label: 'Start', type: 'start', properties: {} },
        },
      ];
      
      const edges: Edge[] = [
        {
          id: 'edge1',
          source: 'node1',
          target: 'node2',
        },
      ];

      const historyEntry = flowService.createHistoryEntry(nodes, edges);
      expect(historyEntry).toEqual({ nodes, edges });
    });

    it('should create deep copies of nodes and edges', () => {
      const nodes: FlowNode[] = [
        {
          id: 'node1',
          type: 'start',
          position: { x: 0, y: 0 },
          data: { label: 'Start', type: 'start', properties: {} },
        },
      ];
      const edges: Edge[] = [];

      const historyEntry = flowService.createHistoryEntry(nodes, edges);
      nodes[0].position.x = 100; // Modify original
      
      expect(historyEntry.nodes[0].position.x).toBe(0); // Copy should be unchanged
    });
  });

  describe('generateSampleFlow', () => {
    it('should generate a sample flow with default name', () => {
      const flow = flowService.generateSampleFlow();
      
      expect(flow).toMatchObject({
        name: 'Sample Flow',
        nodes: expect.arrayContaining([
          expect.objectContaining({ type: 'start' }),
          expect.objectContaining({ type: 'process' }),
          expect.objectContaining({ type: 'finish' }),
          expect.objectContaining({ type: 'mcp' }),
        ]),
      });
    });

    it('should generate a sample flow with custom name', () => {
      const flow = flowService.generateSampleFlow('Custom Sample');
      expect(flow.name).toBe('Custom Sample');
    });
  });
}); 