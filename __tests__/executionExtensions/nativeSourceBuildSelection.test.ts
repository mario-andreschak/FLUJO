import { execFileSync } from 'node:child_process';
import path from 'node:path';

const configPath=path.resolve('next.config.mjs');
const selectedPath=path.resolve('src/backend/execution/extensions/configuredNativeSource.ts');
const parentPath=path.resolve('src/backend/execution/extensions/configuredNativeParent.ts');
function aliases(selection: Record<string,string>, isServer=true) {
  const env={...process.env,...selection};
  if (!selection.FLUJO_NATIVE_PARENT_MODULE) delete env.FLUJO_NATIVE_PARENT_MODULE;
  if (!selection.FLUJO_EXECUTION_ADAPTER_MODULE) delete env.FLUJO_EXECUTION_ADAPTER_MODULE;
  const script=`import {pathToFileURL} from 'node:url';
    const {default:config}=await import(pathToFileURL(process.argv[1]));
    const selected=config.webpack({resolve:{alias:{preserved:'existing'}}},{isServer:${isServer},dev:false});
    process.stdout.write(JSON.stringify(selected.resolve.alias));`;
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,configPath],
    {env,encoding:'utf8',timeout:10000,windowsHide:true,stdio:['ignore','pipe','pipe']})) as Record<string,string>;
}

test('Parent selection applies exact aliases in both server graph spellings and preserves existing aliases', () => {
  const received=aliases({FLUJO_NATIVE_PARENT_MODULE:parentPath});
  expect(received.preserved).toBe('existing');
  expect(received['@/backend/execution/extensions/configuredAdapter$']).toBe(selectedPath);
  expect(received['@/backend/execution/extensions/configuredNativeParent$']).toBe(parentPath);
  expect(received[`${path.resolve('src/backend/execution/extensions/configuredAdapter')}.ts$`]).toBe(selectedPath);
  expect(received[`${path.resolve('src/backend/execution/extensions/configuredNativeParent')}.ts$`]).toBe(parentPath);
});

test('ordinary Source and client graphs receive no private Parent or Native adapter module', () => {
  expect(aliases({})).toEqual({preserved:'existing'});
  expect(aliases({FLUJO_NATIVE_PARENT_MODULE:parentPath},false)).toEqual({preserved:'existing'});
});

test('ambiguous, relative and missing Parent module selections fail before bundling', () => {
  const selections: Record<string,string>[] = [
    {FLUJO_NATIVE_PARENT_MODULE:parentPath,FLUJO_EXECUTION_ADAPTER_MODULE:selectedPath},
    {FLUJO_NATIVE_PARENT_MODULE:'relative-parent.ts'},
    {FLUJO_NATIVE_PARENT_MODULE:path.resolve('not-present-parent.ts')},
  ];
  for (const selection of selections) expect(()=>aliases(selection)).toThrow();
});

test('the default module cannot silently ignore an unapplied Native Parent selector', () => {
  const before=process.env.FLUJO_NATIVE_PARENT_MODULE;
  process.env.FLUJO_NATIVE_PARENT_MODULE=parentPath;
  try {
    expect(()=>jest.isolateModules(()=>require('@/backend/execution/extensions/configuredAdapter')))
      .toThrow('Native Parent composition was selected but its server build hook was not applied.');
  } finally {
    if (before===undefined) delete process.env.FLUJO_NATIVE_PARENT_MODULE;
    else process.env.FLUJO_NATIVE_PARENT_MODULE=before;
  }
});
