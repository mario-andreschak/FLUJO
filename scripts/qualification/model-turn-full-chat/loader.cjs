const ts = require(process.env.INSPECTOR_SOURCE_ROOT + '/node_modules/typescript');
module.exports = function(source) {
  return ts.transpileModule(source, { fileName: this.resourcePath, compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  } }).outputText;
};
