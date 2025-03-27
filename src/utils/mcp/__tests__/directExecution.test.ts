import { execSync } from 'child_process';
import { executeCommand, CommandExecutionOptions, CommandExecutionResult } from '../directExecution';

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn()
}));

// Mock logger
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }))
}));

describe('directExecution', () => {
  const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
  const mockRequestId = 'test-request-id';
  const mockSavePath = '/test/path';
  
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('executeCommand', () => {
    const defaultOptions: CommandExecutionOptions = {
      savePath: mockSavePath,
      command: 'test-command',
      actionName: 'TEST',
      requestId: mockRequestId
    };
    
    it('should execute a command successfully', async () => {
      // Mock successful command execution
      mockExecSync.mockReturnValue('command output');
      
      const result = await executeCommand(defaultOptions);
      
      expect(result.success).toBe(true);
      expect(result.commandOutput).toBe('command output');
      expect(mockExecSync).toHaveBeenCalledWith('test-command', expect.objectContaining({
        cwd: mockSavePath
      }));
    });
    
    it('should handle missing path', async () => {
      const result = await executeCommand({
        ...defaultOptions,
        savePath: ''
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing path for command execution');
      expect(mockExecSync).not.toHaveBeenCalled();
    });
    
    it('should handle command with arguments', async () => {
      mockExecSync.mockReturnValue('command with args output');
      
      const result = await executeCommand({
        ...defaultOptions,
        args: ['arg1', 'arg2']
      });
      
      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('test-command arg1 arg2', expect.anything());
    });
    
    it('should handle arguments with spaces', async () => {
      mockExecSync.mockReturnValue('command with quoted args output');
      
      const result = await executeCommand({
        ...defaultOptions,
        args: ['arg with spaces', 'arg2']
      });
      
      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('test-command "arg with spaces" arg2', expect.anything());
    });
    
    it('should filter out empty arguments', async () => {
      mockExecSync.mockReturnValue('command with filtered args output');
      
      const result = await executeCommand({
        ...defaultOptions,
        args: ['arg1', '', '  ', 'arg2']
      });
      
      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('test-command arg1 arg2', expect.anything());
    });
    
    it('should add environment variables when provided', async () => {
      mockExecSync.mockReturnValue('command with env output');
      
      const result = await executeCommand({
        ...defaultOptions,
        env: { TEST_ENV: 'test-value' }
      });
      
      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('test-command', expect.objectContaining({
        env: expect.objectContaining({
          TEST_ENV: 'test-value'
        })
      }));
    });
    
    it('should add timeout when provided', async () => {
      mockExecSync.mockReturnValue('command with timeout output');
      
      const result = await executeCommand({
        ...defaultOptions,
        timeout: 1000
      });
      
      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('test-command', expect.objectContaining({
        timeout: 1000
      }));
    });
    
    it('should handle command execution error with stdout and stderr', async () => {
      const mockError: any = new Error('Command failed');
      mockError.stdout = Buffer.from('stdout output');
      mockError.stderr = Buffer.from('stderr output');
      mockError.code = 'ERR';
      
      mockExecSync.mockImplementation(() => {
        throw mockError;
      });
      
      const result = await executeCommand(defaultOptions);
      
      expect(result.success).toBe(false);
      expect(result.commandOutput).toBe('stdout outputstderr output');
    });
    
    it('should handle command execution error without output', async () => {
      const mockError: any = new Error('Command failed');
      mockError.code = 'ERR';
      
      mockExecSync.mockImplementation(() => {
        throw mockError;
      });
      
      const result = await executeCommand(defaultOptions);
      
      expect(result.success).toBe(false);
      expect(result.commandOutput).toBe('Command failed: test-command');
    });
    
    it('should handle timeout error gracefully', async () => {
      const mockError: any = new Error('Command timed out');
      mockError.killed = true;
      mockError.code = 'ETIMEDOUT';
      
      mockExecSync.mockImplementation(() => {
        throw mockError;
      });
      
      const result = await executeCommand({
        ...defaultOptions,
        timeout: 1000
      });
      
      expect(result.success).toBe(false);
      expect(result.commandOutput).toContain('Command timed out');
    });
    
    it('should handle unexpected errors during execution', async () => {
      // Mock a throw from outside the try/catch for command execution
      mockExecSync.mockImplementation(() => {
        // This will cause an error in the outer try/catch
        throw new TypeError('Unexpected type error');
      });
      
      const result = await executeCommand(defaultOptions);
      
      expect(result.success).toBe(false);
      expect(result.commandOutput).toContain('Command failed');
    });
    
    it('should handle unexpected non-Error objects', async () => {
      // Mock a throw of a non-Error object
      mockExecSync.mockImplementation(() => {
        throw 'String error'; // Not an Error object
      });
      
      const result = await executeCommand(defaultOptions);
      
      expect(result.success).toBe(false);
      expect(result.commandOutput || result.error).toBeTruthy();
    });
  });
}); 