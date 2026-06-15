export const MASKED_STRING = 'masked:********';

// Placeholder the backend sends to the frontend in place of a real API key. The frontend
// never receives the actual key; when it sends this value back on save, the backend
// interprets it as "keep the existing stored key unchanged".
export const MASKED_API_KEY = '********';

export const ToolCallDefaultPatternJSON = '{"tool": "TOOL_NAME", "parameters": {"PARAM_NAME1":"PARAM_VALUE1$", "$PARAM_NAME2":"$PARAM_VALUE2$", "...": "..." }}'
export const ToolCallDefaultPatternXML = '<TOOL_NAME><PARAM_NAME1>PARAM_VALUE1</PARAM_NAME1><PARAM_NAME2>PARAM_VALUE1</PARAM_NAME2></TOOL_NAME>'

export const ReasoningDefaultPatternJSON = '{"think": "THINK_TEXT"}'
export const ReasoningDefaultPatternXML = '<THINK>THINK_TEXT</THINK>'

export const ReasoningDefaultPattern = ReasoningDefaultPatternJSON
export const ToolCallDefaultPattern = ToolCallDefaultPatternJSON


export const xmlFindPattern = '<([\w-]+)>(?:.+)<\/(\{1})>'