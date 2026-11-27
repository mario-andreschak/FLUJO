# Code a model writes runs only in code mode's QuickJS sandbox, never with node:vm or new Function, and every tool it calls passes the step's tool list and the one approval gate

Node's `vm` module and `new Function` share FLUJO's process, memory and event
loop, so they are not a sandbox. Code mode (#1448) runs a program in QuickJS
compiled to WebAssembly on a worker thread, with time, CPU, memory and call
limits; its tool calls go through `invokeStepTool`, which checks the step's
tool list and asks `createLiveToolApproval` with the real tool name.

Enforced by:
- `flujo/no-node-vm`
- `__tests__/flow/codeModeSandbox.test.ts`
- `__tests__/flow/deferredToolsFlow.test.ts`
- `invokeStepTool` in `src/backend/execution/flow/toolLoading/stepToolInvoker.ts`
