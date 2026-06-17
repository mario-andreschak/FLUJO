import cloneDeep from "lodash/cloneDeep";
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/flow/temp_pocket');

export const DEFAULT_ACTION = "default"; // Default action for 

export abstract class BaseNode {
    public flow_params: any;
    public node_params: any; // Add node_params
    public successors: Map<string, BaseNode>;

    constructor() {
        log.debug(`BaseNode constructor called`);
        this.flow_params = {};
        this.node_params = {}; // Initialize node_params
        this.successors = new Map();
    }

  public setParams(params: any, node_params?: any): void {
    log.debug(`setParams called with params`, { params });
    
    // Add verbose logging of the input parameters
    log.verbose('setParams input', JSON.stringify({
      params,
      node_params
    }));
    
    this.flow_params = params;
    if (node_params) {
        this.node_params = node_params;
    }
    
    log.debug(`setParams finished. flow_params count`, { flow_params: this.flow_params?.length, node_params: this.node_params?.length });
    
    // Add verbose logging of the updated state
    log.verbose('setParams result', JSON.stringify({
      flow_params: this.flow_params,
      node_params: this.node_params
    }));
  }

    public clone(): BaseNode {
        log.debug(`clone called`);
        const newNode = this._clone();
        log.verbose(`_clone result`, { newNode });
        newNode.flow_params = cloneDeep(this.flow_params);
        log.verbose(`Cloned flow_params`, { flow_params: newNode.flow_params });
        newNode.node_params = cloneDeep(this.node_params); // Clone node_params
        log.verbose(`Cloned node_params`, { node_params: newNode.node_params });
        newNode.successors = new Map(this.successors);
        log.verbose(`Cloned successors`, { successors: newNode.successors });
        log.verbose(`clone finished`);
        return newNode;
    }

    abstract _clone(): BaseNode;

    public addSuccessor(newSuccessor: BaseNode, action: string = DEFAULT_ACTION): void {
        log.verbose(`addSuccessor called with action: ${action}`);
        if (this.successors.has(action)) {
            log.error(`Action ${action} already exists`);
            throw new Error(`Action ${action} already exists`);
        }

        
        this.successors.set(action, newSuccessor);
        log.debug(`addSuccessor finished. Successors`, { successors: this.successors });
    }

    public getSuccessor(name: string): BaseNode | undefined {
        log.debug(`getSuccessor called with name: ${name}`);
        if (!this.successors.has(name)) {
            log.error(`Successor ${name} not found`);
            return undefined;
        }

        // This is important for parallel execution to not have race conditions
        const successor = this.successors.get(name)!.clone();
        log.debug(`getSuccessor finished. Returning successor`, { successor });
        return successor;
    }
    
  abstract prep(sharedState: any, node_params?: any): Promise<any>;

  /**
   * We allow you to implement custom wrappers over any core execution logic
   * 
   * Exec handler logic - this could be higher level retry and 
   * robustness logic that could be used across many node types
   * @param prepResult 
   * @returns 
   */
  public async execWrapper(prepResult: any, node_params?: any): Promise<any> {
      log.debug(`execWrapper called with prepResult`, { prepResult });
      
      // Add verbose logging of the input parameters
      log.verbose('execWrapper input', JSON.stringify({
        prepResult,
        node_params
      }));
      
      const result = await this.execCore(prepResult, node_params);
      
      log.debug(`execWrapper finished. Result`, { result });
      
      // Add verbose logging of the result
      log.verbose('execWrapper result', JSON.stringify(result));
      
      return result;
  }

  /**
   * This is the primary execution step of a node and is typically 
   * the core component of a node implementation
   * @param prepResult 
   */
  abstract execCore(prepResult: any, node_params?: any): Promise<any>;

  abstract post(prepResult: any, execResult: any, sharedState: any, node_params?: any): Promise<string>;

    /**
     * Core run logic should not change from node to node implementation.
     * Returns an object containing the action to take next, and the results
     * from the prep and execution phases for potential snapshotting.
     * @param sharedState Contextual state that is shared across nodes
     */
  public async run(sharedState: any): Promise<{ action: string, prepResult: any, execResult: any }> {
    log.debug(`run called with sharedState`, { sharedState });
    log.debug(`Current flow_params at start of run`, { flow_params: this.flow_params });
    
    // Add verbose logging of the input parameters
    log.verbose('run input', JSON.stringify({
      sharedState,
      flow_params: this.flow_params,
      node_params: this.node_params
    }));
    
    const prepResult = await this.prep(sharedState, this.node_params); // Pass node_params to prep
    
    // Add verbose logging of the prep result
    log.verbose('run prepResult', JSON.stringify(prepResult));
    
    const execResult = await this.execWrapper(prepResult, this.node_params); // Pass node_params to execWrapper
    
    // Add verbose logging of the exec result
    log.verbose('run execResult', JSON.stringify(execResult));
    
    const action = await this.post(prepResult, execResult, sharedState, this.node_params); // Pass node_params to post
    
    log.debug(`action`, { action });
    log.debug(`run finished. Returning action: ${action}`);
    
    // Add verbose logging of the final action
    log.verbose('run action result', JSON.stringify({ action, prepResult, execResult }));

    return { action, prepResult, execResult };
  }
}

export abstract class RetryNode extends BaseNode {
    protected maxRetries: number;
    protected intervalMs: number;

    constructor(maxRetries: number, intervalMs: number) {
        log.debug(`RetryNode constructor called with maxRetries: ${maxRetries}, intervalMs: ${intervalMs}`);
        super();
        this.maxRetries = maxRetries;
        this.intervalMs = intervalMs;
    }

  public async execWrapper(prepResult: any, node_params?: any): Promise<any> {
    log.debug(`execWrapper called with prepResult`, { prepResult });
    
    // Add verbose logging of the input parameters
    log.verbose('RetryNode execWrapper input', JSON.stringify({
      prepResult,
      node_params,
      maxRetries: this.maxRetries,
      intervalMs: this.intervalMs
    }));
    
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        const result = await this.execCore(prepResult, node_params);
        log.debug(`execWrapper finished successfully. Result`, { result });
        
        // Add verbose logging of the successful result
        log.verbose('RetryNode execWrapper success result', JSON.stringify(result));
        
        return result;
      } catch (error) {
        log.warn(`Retry attempt ${i+1} failed`, { error });
        
        // Add verbose logging of the retry attempt
        log.verbose('RetryNode execWrapper retry attempt', JSON.stringify({
          attempt: i + 1,
          maxRetries: this.maxRetries,
          error: error instanceof Error ? error.message : String(error)
        }));
        
        await new Promise(resolve => setTimeout(resolve, this.intervalMs));
      }
    }

    log.error(`Max retries reached after ${this.maxRetries} attempts`);
    
    // Add verbose logging of the max retries error
    log.verbose('RetryNode execWrapper max retries reached', JSON.stringify({
      maxRetries: this.maxRetries
    }));
    
    throw new Error("Max retries reached after " + this.maxRetries + " attempts");
  }
}

export class Flow extends BaseNode {
    private start: BaseNode;

    constructor(start: BaseNode) {
        log.debug(`Flow constructor called with start`, { start });
        super();
        this.start = start;
    }

    public _clone(): BaseNode {
        log.debug(`Flow _clone called`);
        // NOTE: I don't think we need to clone the start node here
        // We copy on ready any way during execution
        const newFlow = new Flow(this.start);
        log.debug(`Flow _clone finished. Returning`, { newFlow });
        return newFlow;
    }

    async getStartNode(): Promise<BaseNode> {
        log.debug(`getStartNode called`);
        // This is important for parallel execution to not have race conditions
        const clonedStart = this.start.clone();
        log.debug(`getStartNode finished. Returning`, { clonedStart });
        return clonedStart;
    }

  async execCore(prepResult: any): Promise<any> {
    log.error(`Flow node does not support direct execution`);
    
    // Add verbose logging of the error
    log.verbose('Flow execCore error', JSON.stringify({
      error: "Flow node does not support direct execution"
    }));
    
    throw new Error("Flow node does not support direct execution");
  }

  async prep(sharedState: any, node_params?: any): Promise<any> {
    log.debug(`Flow prep called with sharedState`, { sharedState });
    
    // Add verbose logging of the input parameters
    log.verbose('Flow prep input', JSON.stringify({
      sharedState,
      node_params
    }));
    
    log.debug(`Flow prep finished. Returning empty object`);
    
    // Add verbose logging of the result
    log.verbose('Flow prep result', JSON.stringify({}));
    
    return {}; // Pass through the shared state to exec_core
  }

  async post(prepResult: any, execResult: any, sharedState: any, node_params?: any): Promise<string> {
    log.debug(`Flow post called with prepResult, execResult, and sharedState`, { prepResult, execResult, sharedState });
    
    // Add verbose logging of the input parameters
    log.verbose('Flow post input', JSON.stringify({
      prepResult,
      execResult,
      node_params
    }));
    
    log.debug(`Flow post finished. Returning DEFAULT_ACTION`);
    
    // Add verbose logging of the result
    log.verbose('Flow post result', JSON.stringify({ action: DEFAULT_ACTION }));
    
    return DEFAULT_ACTION;
  }
}
